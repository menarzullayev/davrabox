-- Help assistant (public chat bot on the landing, /help, sign-in and home pages). Owner decisions 5c/5d of
-- 2026-11-26-landing-vs-zoom.md: conversations ARE stored to improve the FAQ, for 30 days, with phone/e-mail/card-like
-- strings masked by the API before they reach this table, and only the platform owner may read them.
--
-- The tables are platform-level (no organization): davra_app gets no direct access, only the narrow SECURITY DEFINER
-- functions below (same pattern as the sign-up tables of 008). Masking happens in the API; the length checks here are
-- a second line so that a bug can never store an unbounded payload.

CREATE TABLE assistant_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_at timestamptz NOT NULL DEFAULT now(),
  lang text NOT NULL CHECK (lang IN ('uz', 'ru', 'en')),
  page text NOT NULL CHECK (page IN ('landing', 'help', 'signin', 'home')),
  -- Keyed hash of the client network address (never the address itself), for abuse review only.
  ip_hash text NOT NULL CHECK (length(ip_hash) <= 128),
  messages integer NOT NULL DEFAULT 0
);
CREATE INDEX assistant_conversations_last_idx ON assistant_conversations (last_at DESC);

CREATE TABLE assistant_messages (
  id bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES assistant_conversations (id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  -- How an assistant answer was produced: FAQ match, language model, the fixed fallback, or a refusal of an off-topic
  -- question. NULL for the user's own message.
  source text CHECK (source IS NULL OR source IN ('faq', 'llm', 'fallback', 'refusal')),
  faq_id text CHECK (faq_id IS NULL OR length(faq_id) <= 64),
  text text NOT NULL CHECK (length(text) <= 4000)
);
CREATE INDEX assistant_messages_conv_idx ON assistant_messages (conversation_id, id);

-- Spend of the language model per UTC day, for the application-side daily cap (the monthly cap is set in the provider
-- console by the owner). Costs are in micro-dollars so that the sums stay integers.
CREATE TABLE assistant_usage_daily (
  day date PRIMARY KEY,
  llm_requests integer NOT NULL DEFAULT 0,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cost_micro_usd bigint NOT NULL DEFAULT 0
);

REVOKE ALL ON assistant_conversations, assistant_messages, assistant_usage_daily FROM PUBLIC, davra_app;
REVOKE ALL ON SEQUENCE assistant_messages_id_seq FROM PUBLIC, davra_app;

-- Appends one message. A NULL or unknown conversation id starts a new conversation; the (possibly new) id is returned.
CREATE FUNCTION assistant_append(p_conv uuid, p_lang text, p_page text, p_ip_hash text, p_role text, p_source text, p_faq_id text, p_text text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF p_conv IS NOT NULL THEN
    UPDATE assistant_conversations SET last_at = now(), messages = messages + 1 WHERE id = p_conv RETURNING id INTO v_id;
  END IF;
  IF v_id IS NULL THEN
    INSERT INTO assistant_conversations (lang, page, ip_hash, messages) VALUES (p_lang, p_page, p_ip_hash, 1) RETURNING id INTO v_id;
  END IF;
  INSERT INTO assistant_messages (conversation_id, role, source, faq_id, text) VALUES (v_id, p_role, p_source, p_faq_id, p_text);
  RETURN v_id;
END $$;

-- Messages of a conversation in order (the API reads the last few as context for the next answer).
CREATE FUNCTION assistant_history(p_conv uuid, p_limit integer)
RETURNS TABLE (role text, source text, faq_id text, text text, at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.role, m.source, m.faq_id, m.text, m.at FROM (
    SELECT * FROM assistant_messages WHERE conversation_id = p_conv ORDER BY id DESC LIMIT greatest(1, least(p_limit, 200))
  ) m ORDER BY m.id
$$;

-- Adds one language-model call to today's totals and returns the new totals.
CREATE FUNCTION assistant_usage_add(p_day date, p_input bigint, p_output bigint, p_cost bigint)
RETURNS TABLE (llm_requests integer, cost_micro_usd bigint)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO assistant_usage_daily AS u (day, llm_requests, input_tokens, output_tokens, cost_micro_usd)
  VALUES (p_day, 1, greatest(p_input, 0), greatest(p_output, 0), greatest(p_cost, 0))
  ON CONFLICT (day) DO UPDATE SET llm_requests = u.llm_requests + 1, input_tokens = u.input_tokens + EXCLUDED.input_tokens,
    output_tokens = u.output_tokens + EXCLUDED.output_tokens, cost_micro_usd = u.cost_micro_usd + EXCLUDED.cost_micro_usd
  RETURNING u.llm_requests, u.cost_micro_usd
$$;

CREATE FUNCTION assistant_usage_get(p_day date)
RETURNS TABLE (llm_requests integer, input_tokens bigint, output_tokens bigint, cost_micro_usd bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(u.llm_requests, 0), coalesce(u.input_tokens, 0), coalesce(u.output_tokens, 0), coalesce(u.cost_micro_usd, 0)
    FROM (SELECT 1) one LEFT JOIN assistant_usage_daily u ON u.day = p_day
$$;

-- Platform-owner view: newest conversations first, keyset pagination on (last_at, id).
CREATE FUNCTION assistant_list(p_before timestamptz, p_before_id uuid, p_limit integer)
RETURNS TABLE (id uuid, created_at timestamptz, last_at timestamptz, lang text, page text, messages integer, first_question text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id, c.created_at, c.last_at, c.lang, c.page, c.messages,
         (SELECT m.text FROM assistant_messages m WHERE m.conversation_id = c.id AND m.role = 'user' ORDER BY m.id LIMIT 1)
    FROM assistant_conversations c
   WHERE p_before IS NULL OR (c.last_at, c.id) < (p_before, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
   ORDER BY c.last_at DESC, c.id DESC
   LIMIT greatest(1, least(p_limit, 100))
$$;

CREATE FUNCTION assistant_delete(p_conv uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n integer;
BEGIN
  DELETE FROM assistant_conversations WHERE id = p_conv;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- Retention (decision 5d): conversations whose last message is older than the cutoff are deleted with their messages;
-- usage rows older than 400 days go too (they hold no personal data, only counts).
CREATE FUNCTION assistant_purge(p_cutoff timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n integer;
BEGIN
  DELETE FROM assistant_conversations WHERE last_at < p_cutoff;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  DELETE FROM assistant_usage_daily WHERE day < (p_cutoff - interval '400 days')::date;
  RETURN v_n;
END $$;

REVOKE ALL ON FUNCTION assistant_append(uuid, text, text, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION assistant_history(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION assistant_usage_add(date, bigint, bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION assistant_usage_get(date) FROM PUBLIC;
REVOKE ALL ON FUNCTION assistant_list(timestamptz, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION assistant_delete(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION assistant_purge(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION assistant_append(uuid, text, text, text, text, text, text, text) TO davra_app;
GRANT EXECUTE ON FUNCTION assistant_history(uuid, integer) TO davra_app;
GRANT EXECUTE ON FUNCTION assistant_usage_add(date, bigint, bigint, bigint) TO davra_app;
GRANT EXECUTE ON FUNCTION assistant_usage_get(date) TO davra_app;
GRANT EXECUTE ON FUNCTION assistant_list(timestamptz, uuid, integer) TO davra_app;
GRANT EXECUTE ON FUNCTION assistant_delete(uuid) TO davra_app;
GRANT EXECUTE ON FUNCTION assistant_purge(timestamptz) TO davra_app;

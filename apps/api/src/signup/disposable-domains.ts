// Throwaway-mailbox providers that must not receive a trial. This is a curated snapshot of well-known services, not a
// complete list (new ones appear daily); operators extend it with SIGNUP_BLOCKED_DOMAINS (comma separated) without a
// release. A subdomain of a listed domain is blocked too; a longer name that merely ends in the same letters is not.
const DISPOSABLE = [
  '10minutemail.com', '10minutemail.net', '10minutemail.org', '20minutemail.com', '33mail.com', '1secmail.com', '1secmail.net',
  '1secmail.org', '7tags.com', 'anonbox.net', 'anonymbox.com', 'armyspy.com', 'binkmail.com', 'bobmail.info', 'bugmenot.com',
  'burnermail.io', 'byom.de', 'chacuo.net', 'cool.fr.nf', 'courriel.fr.nf', 'cuvox.de', 'dayrep.com', 'deadaddress.com',
  'despam.it', 'discard.email', 'discardmail.com', 'discardmail.de', 'disposable.email', 'disposableemailaddresses.com',
  'dispostable.com', 'dodgeit.com', 'dodgit.com', 'dropmail.me', 'dump-email.info', 'dumpmail.de', 'dumpyemail.com',
  'e4ward.com', 'einrot.com', 'email-fake.com', 'emailfake.com', 'emailondeck.com', 'emailsensei.com', 'emailtemporanea.com',
  'emailtemporanea.net', 'emailtemporar.ro', 'emailthe.net', 'emailtmp.com', 'emailwarden.com', 'ephemail.net',
  'fakeinbox.com', 'fakemail.fr', 'fakemailgenerator.com', 'fastacura.com', 'filzmail.com', 'fleckens.hu', 'flurred.com',
  'freemail.ms', 'friendlymail.co.uk', 'fudgerub.com', 'getairmail.com', 'getnada.com', 'girlsundertheinfluence.com',
  'gishpuppy.com', 'grr.la', 'guerrillamail.biz', 'guerrillamail.com', 'guerrillamail.de', 'guerrillamail.info',
  'guerrillamail.net', 'guerrillamail.org', 'guerrillamailblock.com', 'harakirimail.com', 'hidemail.de', 'hulapla.de',
  'imgof.com', 'incognitomail.com', 'incognitomail.net', 'incognitomail.org', 'instant-mail.de', 'jetable.org', 'jourrapide.com',
  'kasmail.com', 'kaspop.com', 'killmail.com', 'killmail.net', 'klzlk.com', 'koszmail.pl', 'kurzepost.de', 'letthemeatspam.com',
  'lroid.com', 'mail-temporaire.fr', 'mail7.io', 'mailcatch.com', 'mailde.de', 'maildrop.cc', 'maileater.com',
  'mailexpire.com', 'mailforspam.com', 'mailfreeonline.com', 'mailguard.me', 'mailhazard.com', 'mailimate.com', 'mailin8r.com',
  'mailinater.com', 'mailinator.com', 'mailinator.net', 'mailinator.org', 'mailinator2.com', 'mailmoat.com', 'mailnesia.com',
  'mailnull.com', 'mailshell.com', 'mailsiphon.com', 'mailtemp.info', 'mailtothis.com', 'mailzilla.com', 'meltmail.com',
  'mintemail.com', 'moakt.com', 'moncourrier.fr.nf', 'monemail.fr.nf', 'monmail.fr.nf', 'mt2015.com', 'mytemp.email',
  'mytrashmail.com', 'nada.email', 'nospam.ze.tc', 'nowmymail.com', 'objectmail.com', 'obobbo.com', 'oneoffemail.com',
  'pjjkp.com', 'plexolan.de', 'pookmail.com', 'proxymail.eu', 'putthisinyourspamdatabase.com', 'quickinbox.com',
  'rcpt.at', 'recode.me', 'regbypass.com', 'rmqkr.net', 'safetymail.info', 'sharklasers.com', 'shieldedmail.com', 'sneakemail.com',
  'sogetthis.com', 'spam4.me', 'spamavert.com', 'spambog.com', 'spambog.de', 'spambog.ru', 'spambox.us', 'spamcero.com',
  'spamday.com', 'spamex.com', 'spamfree24.com', 'spamfree24.de', 'spamfree24.org', 'spamgourmet.com', 'spamherelots.com',
  'spamhereplease.com', 'spamhole.com', 'spamify.com', 'spaml.com', 'spammotel.com', 'spamspot.com', 'spamthis.co.uk',
  'spamtroll.net', 'supermailer.jp', 'teleworm.us', 'temp-mail.io', 'temp-mail.org', 'temp-mail.ru', 'tempail.com', 'tempe-mail.com',
  'tempemail.biz', 'tempemail.co.za', 'tempemail.com', 'tempemail.net', 'tempinbox.co.uk', 'tempinbox.com', 'tempmail.com',
  'tempmail.de', 'tempmail.eu', 'tempmail.net', 'tempmail.us', 'tempmail2.com', 'tempmaildemo.com', 'tempmailer.com',
  'tempmailer.de', 'tempomail.fr', 'temporaryemail.net', 'temporaryforwarding.com', 'temporaryinbox.com', 'thankyou2010.com',
  'thisisnotmyrealemail.com', 'throwam.com', 'throwawayemailaddress.com', 'tmail.ws', 'tmailinator.com', 'tmpmail.net',
  'tmpmail.org', 'trash-mail.at', 'trash-mail.com', 'trash-mail.de', 'trash2009.com', 'trashemail.de', 'trashmail.at',
  'trashmail.com', 'trashmail.de', 'trashmail.io', 'trashmail.me', 'trashmail.net', 'trashmail.org', 'trashmail.ws',
  'trashmailer.com', 'trbvm.com', 'trialmail.de', 'trillianpro.com', 'turual.com', 'twinmail.de', 'tyldd.com', 'uggsrock.com',
  'upliftnow.com', 'uplipht.com', 'venompen.com', 'veryrealemail.com', 'viditag.com', 'viewcastmedia.com', 'wegwerfadresse.de',
  'wegwerfemail.de', 'wegwerfmail.de', 'wegwerfmail.net', 'wegwerfmail.org', 'wh4f.org', 'whyspam.me', 'willhackforfood.biz',
  'willselfdestruct.com', 'wuzupmail.net', 'xagloo.com', 'xemaps.com', 'xents.com', 'xmaily.com', 'xoxy.net', 'yapped.net',
  'yep.it', 'yogamaven.com', 'yopmail.com', 'yopmail.fr', 'yopmail.net', 'yuurok.com', 'zehnminutenmail.de', 'zippymail.info',
  'zoemail.org',
];

const SET = new Set(DISPOSABLE);

function domainOf(email: string): string {
  const e = email.trim().toLowerCase();
  return e.slice(e.lastIndexOf('@') + 1);
}

/** True when the address' domain (or a parent domain of it) is a known throwaway-mail provider or in `extra`. */
export function isDisposable(email: string, extra: readonly string[] = []): boolean {
  const labels = domainOf(email).split('.');
  const blocked = (d: string) => SET.has(d) || extra.includes(d);
  for (let i = 0; i < labels.length - 1; i++) if (blocked(labels.slice(i).join('.'))) return true;
  return false;
}

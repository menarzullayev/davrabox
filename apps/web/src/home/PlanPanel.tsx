import { Badge, IconShieldCheck } from '../ui';
import type { Lang } from '../i18n';
import type { PlanSummary } from './logic';
import { tx } from './text';

/** "Plan & Limits": what the free trial of the organization allows and how long it lasts. Only rendered for trial organizations. */
export function PlanPanel({ lang, plan }: { lang: Lang; plan: PlanSummary }) {
  return (
    <section className="hm-card hm-plan" aria-labelledby="hm-plan-h" data-testid="plan-panel">
      <div className="hm-plan__head">
        <h2 className="hm-card__title" id="hm-plan-h">
          {tx(lang, 'hPlanTitle')}
        </h2>
        <Badge tone={plan.expired ? 'danger' : 'gold'}>
          <IconShieldCheck size={12} />
          {tx(lang, plan.expired ? 'hPlanEnded' : 'hPlanTrial')}
        </Badge>
      </div>
      <dl className="hm-plan__list">
        <div className="hm-plan__item" data-testid="plan-days">
          <dt>{tx(lang, 'hPlanDaysLeft')}</dt>
          <dd className="dx-tabular">{plan.daysLeft}</dd>
        </div>
        {plan.maxParticipants ? (
          <div className="hm-plan__item" data-testid="plan-participants">
            <dt>{tx(lang, 'hPlanParticipants')}</dt>
            <dd className="dx-tabular">{tx(lang, 'hPlanUpTo', { n: plan.maxParticipants })}</dd>
          </div>
        ) : null}
        {plan.maxMinutes ? (
          <div className="hm-plan__item" data-testid="plan-minutes">
            <dt>{tx(lang, 'hPlanMinutes')}</dt>
            <dd className="dx-tabular">{tx(lang, 'hPlanUpToMin', { n: plan.maxMinutes })}</dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}

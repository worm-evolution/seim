import { ChangePlan, EngineerRisk, ProjectManifest } from './types';
import { pathMatchesPolicy } from './handoff';

export interface RiskDecision {
  risk: EngineerRisk;
  allowed: boolean;
  requiresApproval: boolean;
  reasons: string[];
}

const HIGH_RISK_PATHS = /(^|\/)(\.github|\.devcontainer|docker|infra|terraform|k8s|migrations?)(\/|$)|package(-lock)?\.json$/i;
const SENSITIVE_CODE = /\b(auth|authorize|permission|role|rbac|payment|billing|stripe|password|secret|token|credential|process\.env|child_process|eval|new Function)\b/i;

export class RiskPolicy {
  public evaluate(plan: ChangePlan, manifest?: ProjectManifest): RiskDecision {
    const reasons = [...plan.reasons];
    let risk: EngineerRisk = plan.risk;
    const handoff = manifest?.handoff;
    if (handoff?.policies.autonomy === 'observe' || handoff?.policies.autonomy === 'plan') {
      return { risk: 'high', allowed: false, requiresApproval: true, reasons: [...reasons, `Handoff autonomy ${handoff.policies.autonomy} does not allow repository execution`] };
    }

    if (plan.files.length > 10) {
      risk = this.max(risk, 'high');
      reasons.push('Change touches more than 10 files');
    }
    for (const file of plan.files) {
      const protectedPath = handoff?.policies.protectedPaths.find(candidate => pathMatchesPolicy(file.path, candidate));
      if (protectedPath) return { risk: 'critical', allowed: false, requiresApproval: true, reasons: [...reasons, `Handoff protects ${protectedPath} from automated changes`] };
      const approvalPath = handoff?.policies.approvalRequiredPaths.find(candidate => pathMatchesPolicy(file.path, candidate));
      if (approvalPath) { risk = this.max(risk, 'high'); reasons.push(`Handoff requires approval for ${approvalPath}`); }
      if (HIGH_RISK_PATHS.test(file.path)) {
        risk = this.max(risk, 'high');
        reasons.push(`Sensitive project path: ${file.path}`);
      }
      if (SENSITIVE_CODE.test(file.content || '')) {
        risk = this.max(risk, 'high');
        reasons.push(`Sensitive operation detected in ${file.path}`);
      }
      if ((file.content || '').length > 50000) {
        risk = this.max(risk, 'high');
        reasons.push(`Large generated file: ${file.path}`);
      }
    }

    if (risk === 'critical') {
      return { risk, allowed: false, requiresApproval: true, reasons: [...reasons, 'Critical changes are blocked by default'] };
    }
    return { risk, allowed: true, requiresApproval: risk !== 'low', reasons };
  }

  private max(a: EngineerRisk, b: EngineerRisk): EngineerRisk {
    const order: EngineerRisk[] = ['low', 'medium', 'high', 'critical'];
    return order.indexOf(b) > order.indexOf(a) ? b : a;
  }
}

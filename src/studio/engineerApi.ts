import { Request, Response } from 'express';
import { SeimInstance } from '../types';

/** Handles the authenticated engineer control-plane API independently of the dashboard renderer. */
export async function handleEngineerApi(req: Request, res: Response, instance: SeimInstance): Promise<boolean> {
  const path = req.path || req.url || '';
  if (!path.includes('/api/engineer/')) return false;

  try {
    if (path.endsWith('/jobs') && req.method === 'GET') {
      res.json(instance.engineer ? await instance.engineer.list() : []);
      return true;
    }
    if (path.endsWith('/applications') && req.method === 'GET') {
      res.json(instance.engineer ? await instance.engineer.listApplications() : []);
      return true;
    }
    if (path.endsWith('/plans') && req.method === 'GET') {
      res.json(instance.engineer ? await instance.engineer.listPlans() : []);
      return true;
    }
    if (path.endsWith('/feedback') && req.method === 'GET') {
      res.json(instance.githubFeedback ? await instance.githubFeedback.list() : []);
      return true;
    }

    if (req.method !== 'POST') return false;
    if (!instance.engineer) {
      res.status(503).json({ success: false, error: 'Engineer unavailable' });
      return true;
    }

    const body = req.body || {};
    if (path.endsWith('/handoff')) {
      if (typeof body.rootDir !== 'string') { res.status(400).json({ success: false, error: 'rootDir is required' }); return true; }
      const application = await instance.engineer.handoffApplication(body.rootDir, body.baseBranch);
      res.json({ success: true, application });
      return true;
    }
    if (path.endsWith('/goals')) {
      const plan = await instance.engineer.submitGoal(body);
      res.json({ success: true, plan });
      return true;
    }
    if (path.endsWith('/run-plan')) {
      const plan = await instance.engineer.runPlan(body.planId, { maxVerificationMs: body.maxVerificationMs });
      res.json({ success: true, plan });
      return true;
    }
    if (path.endsWith('/approve-task')) {
      const plan = await instance.engineer.approveTask(body.planId, body.taskId);
      res.json({ success: true, plan });
      return true;
    }
    if (path.endsWith('/merge-task')) {
      const plan = await instance.engineer.mergeTask(body.planId, body.taskId);
      res.json({ success: true, plan });
      return true;
    }
    if (path.endsWith('/complete-task')) {
      const plan = await instance.engineer.completeTask(body.planId, body.taskId);
      res.json({ success: true, plan });
      return true;
    }
    let job;
    if (path.endsWith('/submit')) {
      const issue = instance.issueStream?.getAllIssues().find((item: any) => item.id === body.issueId);
      if (!issue) {
        res.status(400).json({ success: false, error: 'Issue not found' });
        return true;
      }
      job = await instance.engineer.submit(issue, { baseBranch: body.baseBranch, autoRun: body.autoRun === true });
    } else {
      const jobId = body.jobId;
      if (!jobId || typeof jobId !== 'string') {
        res.status(400).json({ success: false, error: 'jobId is required' });
        return true;
      }
      if (path.endsWith('/run')) {
        job = await instance.engineer.run(jobId);
      } else if (path.endsWith('/approve')) {
        job = await instance.engineer.approve(jobId);
      } else if (path.endsWith('/merge')) {
        job = await instance.engineer.merge(jobId);
      } else if (path.endsWith('/rollback')) {
        job = await instance.engineer.rollback(jobId);
      } else {
        return false;
      }
    }

    res.json({ success: true, job });
    return true;
  } catch (error) {
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    res.status(400).json({
      success: false,
      error: 'Engineer operation failed',
      requestId,
    });
    return true;
  }
}

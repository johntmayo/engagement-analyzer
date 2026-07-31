import { sheetsErrorMessage } from '../../lib/google-sheets';
import {
  saveIdentityDecision,
  saveSessionOverride,
  saveSessionRule,
} from '../../lib/review-store';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { decisionType } = req.body || {};
    if (decisionType === 'identity') {
      const result = await saveIdentityDecision(req.body);
      return res.status(200).json({ ok: true, ...result });
    }
    if (decisionType === 'session') {
      const result = await saveSessionRule(req.body);
      return res.status(200).json({ ok: true, ...result });
    }
    if (decisionType === 'session_override') {
      const result = await saveSessionOverride(req.body);
      return res.status(200).json({ ok: true, ...result });
    }
    return res.status(400).json({ error: 'Unsupported decision type' });
  } catch (error) {
    console.error('Review decision failed:', error);
    return res.status(500).json({
      ok: false,
      error: sheetsErrorMessage(error),
    });
  }
}

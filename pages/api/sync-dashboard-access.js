import { syncDashboardAccess } from '../../lib/sync-dashboard-access';
import { sheetsErrorMessage } from '../../lib/google-sheets';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const result = await syncDashboardAccess();
    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    console.error('Dashboard access sync failed:', error);
    const status = /No dashboard access source configured/i.test(error.message)
      ? 400
      : 500;
    return res.status(status).json({
      ok: false,
      error: sheetsErrorMessage(error) || error.message || 'Dashboard access sync failed',
    });
  }
}

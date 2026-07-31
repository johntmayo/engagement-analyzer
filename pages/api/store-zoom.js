import { syncZoomSessionsToSheets } from '../../lib/sync-zoom';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sessions = req.body?.sessions;
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return res.status(400).json({ error: 'A non-empty sessions array is required' });
  }
  if (sessions.length > 2000) {
    return res.status(413).json({ error: 'At most 2,000 sessions can be stored at once' });
  }

  try {
    const result = await syncZoomSessionsToSheets(sessions);
    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    console.error('Zoom sheet storage failed:', error);
    return res.status(500).json({
      ok: false,
      error: error.message || 'Zoom data could not be stored',
    });
  }
}

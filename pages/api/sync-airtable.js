import { syncAirtableCaptains } from '../../lib/sync-airtable';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const result = await syncAirtableCaptains();
    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    console.error('Airtable sync failed:', error);
    return res.status(500).json({
      ok: false,
      error: error.message || 'Airtable synchronization failed',
    });
  }
}

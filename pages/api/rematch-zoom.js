import { sheetsErrorMessage } from '../../lib/google-sheets';
import { rematchStoredZoomData } from '../../lib/rematch-zoom';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const result = await rematchStoredZoomData();
    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    console.error('Zoom rematch failed:', error);
    return res.status(500).json({
      ok: false,
      error: sheetsErrorMessage(error),
    });
  }
}

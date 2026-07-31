import {
  getGmailIntegrationStatus,
  storeEmailEvents,
  syncGmailMailbox,
} from '../../lib/sync-gmail';
import { sheetsErrorMessage } from '../../lib/google-sheets';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, ...getGmailIntegrationStatus() });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    if (Array.isArray(req.body?.events)) {
      const result = await storeEmailEvents(req.body.events);
      return res.status(200).json({ ok: true, ...result });
    }
    const result = await syncGmailMailbox();
    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    console.error('Gmail sync failed:', error);
    const status = error.statusCode || 500;
    return res.status(status).json({
      ok: false,
      error: sheetsErrorMessage(error) || error.message || 'Gmail sync failed',
      details: error.details || undefined,
    });
  }
}

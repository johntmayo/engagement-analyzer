// pages/api/zoom-token.js
// Server-side token exchange - credentials never exposed to browser

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const accountId = process.env.ZOOM_ACCOUNT_ID;
  const clientId = process.env.ZOOM_CLIENT_ID;
  const clientSecret = process.env.ZOOM_CLIENT_SECRET;

  if (!accountId || !clientId || !clientSecret) {
    return res.status(500).json({ 
      error: 'Zoom credentials not configured. Add ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, and ZOOM_CLIENT_SECRET to your environment variables.' 
    });
  }

  try {
    const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const response = await fetch(
      `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${accountId}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${creds}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ 
        error: `Zoom auth failed: ${response.status}`, 
        details: text 
      });
    }

    const data = await response.json();
    // Return account_id alongside the token so the client never needs to call /users/me
    return res.status(200).json({ access_token: data.access_token, account_id: accountId });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
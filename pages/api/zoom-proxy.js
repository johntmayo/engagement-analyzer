// pages/api/zoom-proxy.js
// Proxies all Zoom API calls server-side to avoid CORS

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { token, path, params } = req.body;

  if (!token || !path) {
    return res.status(400).json({ error: 'Missing token or path' });
  }

  try {
    const url = new URL(`https://api.zoom.us/v2${path}`);
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== '') {
          url.searchParams.set(k, v);
        }
      });
    }

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const NOTION_KEY = process.env.NOTION_KEY;
  const DB_IDS = {
    mock: process.env.NOTION_DB_ID,
    gisul_yesang: process.env.NOTION_DB_ID_GISUL_YESANG,
    gisul: process.env.NOTION_DB_ID_GISUL,
  };

  const { subjects, cursor, dbKey = 'mock' } = req.body || {};

  if (!Object.prototype.hasOwnProperty.call(DB_IDS, dbKey)) {
    return res.status(400).json({ error: '알 수 없는 dbKey입니다' });
  }

  const DB_ID = DB_IDS[dbKey];

  if (!NOTION_KEY || !DB_ID) {
    return res.status(500).json({ error: '환경변수가 설정되지 않았습니다' });
  }

  let filterBody = {};
  if (subjects && subjects.length > 0) {
    filterBody = {
      filter: subjects.length === 1
        ? { property: '과목', select: { equals: subjects[0] } }
        : { or: subjects.map(s => ({ property: '과목', select: { equals: s } })) }
    };
  }

  const body = { page_size: 100, ...filterBody };
  if (cursor) body.start_cursor = cursor;

  try {
    const response = await fetch(
      `https://api.notion.com/v1/databases/${DB_ID}/query`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${NOTION_KEY}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.message || 'Notion API 오류' });
    }

    return res.status(200).json(data);

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

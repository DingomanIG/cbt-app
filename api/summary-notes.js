export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const NOTION_KEY = process.env.NOTION_KEY;
  const DB_ID = process.env.NOTION_DB_ID_NOTES;

  if (!NOTION_KEY || !DB_ID) {
    return res.status(500).json({ error: '환경변수가 설정되지 않았습니다' });
  }

  const { subjects, cursor } = req.body || {};

  const excludeFilter = { property: '반영금지', checkbox: { equals: false } };
  let subjectFilter = null;
  if (subjects && subjects.length > 0) {
    subjectFilter = subjects.length === 1
      ? { property: '과목', select: { equals: subjects[0] } }
      : { or: subjects.map(s => ({ property: '과목', select: { equals: s } })) };
  }
  const filterBody = {
    filter: subjectFilter ? { and: [subjectFilter, excludeFilter] } : excludeFilter
  };

  const body = { page_size: 100, ...filterBody };
  if (cursor) body.start_cursor = cursor;

  try {
    const queryRes = await fetch(
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

    const data = await queryRes.json();

    if (!queryRes.ok) {
      return res.status(queryRes.status).json({ error: data.message || 'Notion API 오류' });
    }

    const pages = data.results || [];
    const results = await Promise.all(pages.map(async (page) => {
      const blocksRes = await fetch(
        `https://api.notion.com/v1/blocks/${page.id}/children?page_size=100`,
        {
          headers: {
            'Authorization': `Bearer ${NOTION_KEY}`,
            'Notion-Version': '2022-06-28',
          },
        }
      );
      const blocksData = await blocksRes.json();
      return { page, blocks: blocksRes.ok ? (blocksData.results || []) : [] };
    }));

    return res.status(200).json({
      results,
      has_more: data.has_more,
      next_cursor: data.next_cursor,
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

/* 프로(유료) 권한 판정 — questions.js / summary-notes.js 가 공유한다.
   클라이언트에서만 가리면 개발자도구로 다 보이므로, 프로 전용 데이터는
   여기서 판정한 뒤 응답에서 필드 자체를 빼는 방식으로 막는다. */

/* 클라이언트가 Supabase 세션의 access_token 을 실어 보낸다 */
export function bearerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

/* 토큰이 없거나 검증에 실패하면 무료로 본다 (실패 시 잠기는 쪽이 안전하다) */
export async function isProRequest(supabase, req) {
  const token = bearerToken(req);
  if (!token) return false;

  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData || !userData.user) return false;

  const { data, error } = await supabase
    .from('user_entitlements')
    .select('is_pro,expires_at')
    .eq('user_id', userData.user.id)
    .maybeSingle();
  if (error || !data || !data.is_pro) return false;

  return !data.expires_at || new Date(data.expires_at).getTime() > Date.now();
}

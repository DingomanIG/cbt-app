/* 약관·환불정책·개인정보처리방침 공용 스크립트.
 *
 * 하는 일은 하나: "← 앱으로 돌아가기"를 눌렀을 때 앱의 **설정 화면**으로 돌아가게 한다.
 *
 * 예전에는 그냥 `/` 로 갔는데, 앱이 SPA라 주소만으로는 어느 화면이었는지 알 수 없어
 * 홈으로 튕겼다. 설정 → 이용약관 → 뒤로 를 누른 사람이 홈에 떨어지는 셈이었다.
 *
 * 앱 안에서 들어왔다면 history.back() 이 가장 낫다 — 새로고침이 없으므로 설정 화면은
 * 물론 그때까지의 앱 상태가 통째로 살아있다. 주소창에 직접 쳤거나 검색·새 탭으로
 * 들어온 경우에는 돌아갈 history 가 없으므로 링크의 href 를 그대로 따른다.
 */

(function () {
  // 머리말의 "← 앱으로 돌아가기"와 맨 아래 같은 링크, 둘 다 같게 동작해야 한다
  var links = document.querySelectorAll('.doc-head .back, .doc-foot a[href="/"]');
  if (!links.length) return;

  function cameFromApp() {
    if (!document.referrer) return false;
    try {
      return new URL(document.referrer).origin === location.origin;
    } catch (e) {
      return false;
    }
  }

  // 앱에서 들어온 경우에만 가로챈다. 직접 들어온 사람에게는 홈 링크가 맞다.
  if (!cameFromApp() || history.length <= 1) return;

  Array.prototype.forEach.call(links, function (a) {
    a.addEventListener('click', function (e) {
      e.preventDefault();
      history.back();
    });
  });
})();

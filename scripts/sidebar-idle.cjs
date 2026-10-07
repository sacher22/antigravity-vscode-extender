// Empty input disables Send by design; that does not indicate an active CLI turn.
function sidebarIdle(document) {
  const send=document.querySelector('#send-btn');
  const mode=document.querySelector('#mode-select');
  const fresh=document.querySelector('#new-session-btn');
  return Boolean(send && mode && fresh && !document.querySelector('#stop-btn') && !mode.disabled && !fresh.disabled);
}
module.exports={sidebarIdle};

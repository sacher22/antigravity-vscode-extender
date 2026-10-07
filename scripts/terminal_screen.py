"""Benchmark-only terminal decoder; isolated pinned PyPI wheels, no system install."""
import codecs,pathlib,sys,re
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'diagnostics/terminal-decoder-deps'))
import pyte
class TerminalScreen:
 def __init__(self,columns=300,rows=60):
  self.screen=pyte.Screen(columns,rows);self.stream=pyte.Stream(self.screen)
  self.decoder=codecs.getincrementaldecoder('utf-8')('replace')
 def feed(self,data):self.stream.feed(self.decoder.decode(data))
 def text(self):return '\n'.join(self.screen.display)

 def answer_ready(self,marker):
  text=self.text();lines=[line.strip() for line in text.splitlines() if line.strip()]
  # Idle state is CURRENT bottom footer, never an older footer above busy text.
  idle=bool(lines and lines[-1].startswith('? for shortcuts'))
  answer=re.search(r'(?m)^\s*(?:[•●⏺]\s*)?(?:\*\*)?'+re.escape(marker)+r'(?:\*\*)?\s*$',text)
  return bool(idle and answer)

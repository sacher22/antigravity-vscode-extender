import pathlib,sys,unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
from terminal_screen import TerminalScreen
class ScreenCases(unittest.TestCase):
 def test_fragmented_cursor_response_is_one_answer(self):
  screen=TerminalScreen();screen.feed(b'SHORT_DONE_2');screen.feed(b'\x1b[2;1HGenerating');screen.feed(b'\x1b[1;13H50_3')
  self.assertEqual(screen.text().splitlines()[0].strip(),'SHORT_DONE_250_3')
 def test_incremental_utf8_unicode_and_ansi_split(self):
  screen=TerminalScreen();data='你好🙂\x1b[2;1Hdone'.encode()
  for byte in data:screen.feed(bytes([byte]))
  self.assertEqual(screen.text().splitlines()[0].strip(),'你好🙂');self.assertEqual(screen.text().splitlines()[1].strip(),'done')
 def test_clear_redraw_does_not_match_old_answer(self):
  screen=TerminalScreen();screen.feed(b'OLD_ANSWER\x1b[2J\x1b[HNEW_ANSWER');self.assertNotIn('OLD_ANSWER',screen.text());self.assertIn('NEW_ANSWER',screen.text())
 def test_tool_cards_and_idle_footer_keep_spatial_order(self):
  screen=TerminalScreen();screen.feed('● Read(input.txt)\r\nANSWER\r\n? for shortcuts'.encode());text=screen.text();self.assertLess(text.index('ANSWER'),text.index('? for shortcuts'));self.assertIn('● Read(input.txt)',text)
 def test_thinking_marker_with_busy_footer_is_not_final(self):
  screen=TerminalScreen();screen.feed(b'ANSWER\r\n? for shortcuts\r\nReading file\r\nesc to cancel')
  self.assertFalse(screen.answer_ready('ANSWER'))
 def test_current_bottom_idle_and_final_marker_ready(self):
  screen=TerminalScreen();screen.feed(b'ANSWER\r\nesc to cancel');self.assertFalse(screen.answer_ready('ANSWER'))
  screen.feed(b'\x1b[2J\x1b[HANSWER\r\n? for shortcuts');self.assertTrue(screen.answer_ready('ANSWER'))
 def test_wrong_marker_and_prompt_echo_never_ready(self):
  screen=TerminalScreen();screen.feed(b'Reply exactly ANSWER.\r\n? for shortcuts');self.assertFalse(screen.answer_ready('ANSWER'))
  screen.feed(b'\x1b[2J\x1b[HOLD_ANSWER\r\n? for shortcuts');self.assertFalse(screen.answer_ready('ANSWER'))
if __name__=='__main__':unittest.main()

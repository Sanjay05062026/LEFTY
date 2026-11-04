// Checks where a goal goes: words in the main page, or something done on screen. Run: npm run test:route

const { wantsChat, wantsDetail } = require('../src/route');

let failed = 0;
function check(condition, message) {
  if (!condition) failed += 1;
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${message}`);
}

for (const goal of ['what is a linked list', 'who wrote Hamlet?', 'why is the sky blue', 'explain recursion', 'compare React and Vue',
  'how does wifi work', 'translate hello to tamil', 'tell me about black holes', 'write a poem about rain', 'write me an email to my boss',
  'give me a study plan', 'is python faster than java?', 'can you explain closures', 'summarize the french revolution', 'make a list of healthy snacks']) {
  check(wantsChat(goal), `answered in words: "${goal}"`);
}
for (const goal of ['open VS Code', 'save this', 'click the Save button', 'build me a portfolio website', 'create a JSON file on my desktop',
  'focus 30 minutes on VS Code', "I'm stuck, what next?", 'what does this button do', 'how do I save this file', 'File > Save as',
  'write a python function that adds two numbers', 'install the python extension', 'delete this file', 'please open notepad', 'what is on my screen',
  'open Calculator and work out 12 times 8', 'play some music', '']) {
  check(!wantsChat(goal), `done on screen: "${goal}"`);
}
for (const goal of ['explain recursion in detail', 'compare React and Vue', 'write an essay about climate change', 'pros and cons of solar power', 'tell me everything about black holes', 'difference between TCP and UDP']) {
  check(wantsDetail(goal), `long, so it opens in the main window: "${goal}"`);
}
for (const goal of ['what is 25 times 4', 'who wrote Hamlet', 'open VS Code', 'click the details button', 'open the report']) {
  check(!wantsDetail(goal), `fits in the bubble, or isn't a question: "${goal}"`);
}

console.log(failed ? `\n${failed} route checks failed.` : '\nAll route checks passed.');
process.exitCode = failed ? 1 : 0;

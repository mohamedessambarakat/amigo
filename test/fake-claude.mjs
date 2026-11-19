// A stand-in for Claude Code whose launch fails at once, as `claude --resume` of a session with no transcript does.
// It reports any session variable it inherited from the session that started it, then exits 1 with an error on stderr.
if (process.env.CLAUDE_CODE_SESSION_ID) console.error(`inherited CLAUDE_CODE_SESSION_ID=${process.env.CLAUDE_CODE_SESSION_ID}`);
console.error(`No conversation found with session ID: ${process.argv[process.argv.indexOf('--session-id') + 1]}`);
process.exit(1);

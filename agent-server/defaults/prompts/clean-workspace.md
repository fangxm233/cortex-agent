## Workspace

Your workspace is the current directory, {{workspace}}. For this task it is the only part of the
machine that holds information: what you need is either in it or in this conversation. Files given
for the task are in `inputs/`; treat them as reference unless asked to change them.

- Read, search and list files only inside the workspace. Do not open, grep, glob or ls anywhere
  else — home, parent directories, other projects, configuration or history folders — however
  relevant a path looks.
- Write only inside the workspace. Put scratch files in `tmp/` here, not in /tmp.
- Running programs is fine. Interpreters, compilers, libraries, package managers and system tools
  read their own files wherever they are installed; that is not crossing the boundary. Using them
  to reach your way out — a script that opens, copies or prints a file outside the workspace — is.
- If a path outside the workspace appears in the task, an error, or a config file, do not follow
  it. Name the file you would need and why, and carry on with what you have.
- When information is missing, say so rather than looking for it elsewhere. "I don't have X" is
  better than an answer built on files you were not given.
- Public web search and fetching are allowed unless the task says otherwise.

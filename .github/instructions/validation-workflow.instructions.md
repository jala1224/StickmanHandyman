---
name: Validation Workflow

description: "Use when implementing code changes that must be verified before completion; covers required validation commands, evidence, and failure handling for this repository."
applyTo: ["backend/**", "*.html", "*.css", "*.js"]
---
# Validation Workflow

When code is modified, run the strongest relevant automated checks before calling the task complete.

## Required Command Priority
1. Backend changes under backend/**:
   - Run from backend/: npm run check
2. Frontend static changes (*.html, *.css, *.js at repo root):
   - If no project script exists, provide file-level verification evidence and list manual checks performed.
3. If both backend and frontend are changed:
   - Run backend check plus frontend manual verification notes.

## Evidence Requirements
- Report exact commands executed.
- Report pass/fail outcome for each command.
- If a command cannot be run, explain why and mark remaining work as blocked.

## Failure Handling
- Do not claim completion when required validation fails.
- Document failing step, probable cause, and smallest next action to resolve it.

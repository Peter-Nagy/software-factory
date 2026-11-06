# Factory dashboard

React, TypeScript, Vite, Tailwind and shadcn/ui (Base UI). The orchestrator serves the built app from `dist/` at
http://localhost:4777, behind the same login cookie as the API. `ops/setup.sh` builds it.

```bash
npm install
npm run build      # what the orchestrator serves
npm run dev        # hot reload on :5173; proxies /api to the running orchestrator
```

For `npm run dev`, log in once at http://localhost:4777 (the link from `factory dashboard-url`), then use the
`localhost:5173` page in the same browser. The session cookie is shared, because cookies don't depend on the port.

- `src/pages/`: Board, Projects, project page, Plans, plan page, Activity
- `src/components/`: board, task panel, question cards, plan conversation, dialogs; `ui/` is shadcn
- Text written by agents is rendered as React elements (`components/markdown.tsx`), never as HTML.

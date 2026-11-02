# Zombi Roles

A self-hosted Discord bot that adds or removes roles for hundreds of members at once. It is run from a local control panel in the browser or the `/rolebatch` slash command.

## For developers

You need Node.js 24 or newer. Run the tests with:

```bash
npm test
```

Start the control panel at `http://127.0.0.1:4646` with:

```bash
npm start
```

To check the design with 900 made-up members and no connection to Discord, use:

```bash
npm run demo
```

Then open `http://127.0.0.1:4647`.

Design rules are in [docs/design.md](docs/design.md), and setup is in [docs/setup-guide.html](docs/setup-guide.html). [PORTING.md](PORTING.md) describes the later move into zombi.dev.

`src/core` holds the batch logic: name cleanup, matching, dry run, pacing, results, and undo. It never talks to Discord or the disk directly, so it can move into zombi.dev later.

## Copyright

Copyright (c) 2026 Zombi Enterprises, LLC. All rights reserved. The bundled fonts keep their own SIL Open Font License, in `public/fonts`.

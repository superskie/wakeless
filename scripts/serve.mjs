#!/usr/bin/env node
// Local server for the web desk, listening on 127.0.0.1 only and answering
// only Host names of this machine. It serves only web/, src/, examples/,
// research/ and brand/ (the logo boards), never dotfiles, so .env can not
// leak; the path and Host checks live in scripts/static-files.mjs, with tests.
// No dependencies.
// /api/agent/* runs the same Agent API proxy as the hosted site's Pages
// Function, with the partner key read from .env on this machine.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentProxy } from '../src/agent/proxy.mjs';
import { readEnvFile } from '../src/env.mjs';
import { HOST, devHandler } from './static-files.mjs';

// --root site serves the hosted build from scripts/build-site.mjs instead.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootAt = process.argv.indexOf('--root');
const ROOT = rootAt >= 0 ? path.resolve(REPO, process.argv[rootAt + 1]) : REPO;
const PORT = Number(process.env.PORT) || 8787;

const env = readEnvFile(path.join(REPO, '.env'));
const proxy = agentProxy({ apiKey: env.NEAR_INTENTS_AGENT_API_KEY, upstream: env.NEAR_INTENTS_AGENT_API_URL || undefined });
// The root is the landing page: web/home.html in the repo, its copy index.html in the build.
const built = ROOT !== REPO;
const handler = devHandler({ root: ROOT, landing: built ? 'index.html' : 'web/home.html', rootFiles: built ? ['index.html'] : [], port: PORT, proxy });
http.createServer(handler).listen(PORT, HOST, () => console.log(`Wakeless web: http://localhost:${PORT}/web/ (listening on ${HOST} only)`));

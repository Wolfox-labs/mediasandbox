import path from 'node:path';
import os from 'node:os';
import { LocalSandbox } from '../local/local-sandbox.js';
import { defineProviderSuite } from '../testing/provider-suite.js';

const rootDir = path.join(os.tmpdir(), `mediasandbox-local-test-${process.pid}`);
const provider = new LocalSandbox({ rootDir });
const handle = await provider.create(`suite${process.pid}`, 'frontend');

defineProviderSuite({
  provider,
  name: 'LocalSandbox',
  handle,
  enforcesIsolation: false,
});

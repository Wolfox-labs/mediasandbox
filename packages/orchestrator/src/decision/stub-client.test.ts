import { StubDecisionClient } from '../decision/stub-client.js';
import { defineDecisionContract } from '../testing/decision-contract.js';

// 只预设契约测试里需要特定取值的项；其余问题走桩的默认答案。
const client = new StubDecisionClient()
  .setLatency(0)
  .onChoice('q_b', 'b', { a: 0.2, b: 0.7, c: 0.1 });

defineDecisionContract({ client, name: 'StubDecisionClient', isStub: true });

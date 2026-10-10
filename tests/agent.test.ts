import test from 'node:test';
import assert from 'node:assert/strict';
import agent from '../src/index.ts';
import { FABLE_MODEL } from '../src/model.ts';

test('both the coworker and every workflow agent step request only Fable 5.1', () => {
  assert.equal(agent.getModel(), FABLE_MODEL);
  const workflows = agent.getWorkflows();
  assert.ok(workflows.length);
  let agentSteps = 0;
  for (const workflow of workflows) {
    for (const entry of workflow.__serializeGraph().definition.graph) {
      if (entry.type === 'agent') {
        agentSteps++;
        assert.equal(entry.model, FABLE_MODEL);
        assert.equal('modelClass' in entry, false);
      }
    }
  }
  assert.ok(agentSteps);
});

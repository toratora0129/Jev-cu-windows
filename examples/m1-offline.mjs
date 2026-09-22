// 人工データと偽transportのみ。キー読込・ネットワーク・GUI・ファイル保存なし。
import { chooseOperation } from '../scripts/operation-choice.mjs';
import { DEFAULT_MODEL } from '../scripts/jev-decide.mjs';

const operations = [{
  id: 'A1', batchId: 'synthetic-batch', observationId: 'synthetic-observation',
  kind: 'press_key', args: {key: '2'},
  description: 'Enter digit 2 into a synthetic test calculator currently displaying 0',
}];
const result = await chooseOperation({
  operations,
  state: {app: 'SyntheticCalculator', display: '0', goal: 'Enter digit 2'},
  apiKey: 'FAKE_M1_ONLY',
  fetchImpl: async (_url, {body}) => {
    const request = JSON.parse(body);
    const probabilities = Object.fromEntries(Object.keys(request.questions.operation.criteria).map(id => [id, id === 'A1' ? 1 : 0]));
    return new Response(JSON.stringify({
      model: DEFAULT_MODEL,
      answers: {operation: {type: 'choice', choice: 'A1', confidence: 1, probabilities}},
      usage: {input_tokens: 100, output_tokens: 10},
    }), {headers: {'content-type': 'application/json'}});
  },
});
console.log(JSON.stringify({mode: 'offline_mock_no_execution', ...result}, null, 2));

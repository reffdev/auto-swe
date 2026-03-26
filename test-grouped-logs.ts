import { Db } from './src/server/db';
import express from 'express';
import request from 'supertest';

const db = new Db(':memory:');
const app = express();
app.use(express.json());
app.use('/api', require('./src/server/api').createApiRouter(db));

// Create test data
const project = db.createProject({ name: 'test', workdir: '/tmp/test' });
const issue1 = db.createIssue({ project_id: project.id, title: 'Bug fix', status: 'pending' });
const issue2 = db.createIssue({ project_id: project.id, title: 'Feature', status: 'running' });

// Create LLM requests
db.createLlmRequest({ 
  issue_id: issue1.id, 
  model_id: 'gpt-4',
  input_text: 'Hello world',
  output_text: 'Hi there',
  prompt_tokens: 10,
  completion_tokens: 5,
  duration_ms: 200
});

db.createLlmRequest({ 
  issue_id: issue1.id, 
  model_id: 'gpt-4',
  input_text: 'How are you?',
  output_text: 'I am fine',
  prompt_tokens: 15,
  completion_tokens: 8,
  duration_ms: 150
});

db.createLlmRequest({ 
  issue_id: issue2.id, 
  model_id: 'claude-3',
  input_text: 'Test input',
  output_text: '',
  prompt_tokens: 20,
  completion_tokens: 0,
  duration_ms: 300
});

db.createLlmRequest({ 
  issue_id: null, 
  model_id: 'gpt-4',
  input_text: 'Unassigned request',
  output_text: 'Response',
  prompt_tokens: 5,
  completion_tokens: 3,
  duration_ms: 100
});

console.log('Test data created successfully');

// Test the grouped endpoint
request(app)
  .get('/api/llm-logs/grouped')
  .expect(200)
  .then(res => {
    console.log('Response:', JSON.stringify(res.body, null, 2));
    console.log('Total groups:', res.body.total_groups);
    console.log('Total calls:', res.body.total_calls);
    console.log('Groups:', res.body.groups.length);
    process.exit(0);
  })
  .catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });

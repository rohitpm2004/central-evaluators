import pkg from 'pg';
const { Client } = pkg;
const client = new Client({
  connectionString: 'postgresql://postgres:postgres@localhost:5432/async_lms'
});
async function run() {
  await client.connect();
  const res = await client.query("SELECT score, execution_logs, rubric, rubric_breakdown, repo_url FROM college_assignment_submissions ORDER BY submitted_at DESC LIMIT 1;");
  console.log(JSON.stringify(res.rows[0], null, 2));
  await client.end();
}
run();

require('dotenv').config()

console.log('AI_PROVIDER:', process.env.AI_PROVIDER)
console.log('GROQ_API_KEY:', process.env.GROQ_API_KEY?.slice(0, 15) + '...')
console.log('GROQ_MODEL:', process.env.GROQ_MODEL)

async function test() {
  const Groq = await import('groq-sdk')
  const client = new Groq.default({ apiKey: process.env.GROQ_API_KEY })
  const res = await client.chat.completions.create({
    model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
    max_tokens: 50,
    messages: [{ role: 'user', content: 'say hi' }]
  })
  console.log('✅ Success:', res.choices[0].message.content)
}

test().catch(err => {
  console.error('❌ Error:', err.message)
  console.error('Status:', err.status)
  console.error('Details:', err.error)
})
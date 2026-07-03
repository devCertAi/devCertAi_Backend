function calculateLevel(score) {
  if (score >= 75) return 'Advanced'
  if (score >= 50) return 'Intermediate'
  return 'Beginner'
}

function isPassing(score) {
  return score >= 50
}

function fishYatesShuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

module.exports = { calculateLevel, isPassing, fishYatesShuffle }

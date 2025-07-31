const fetchInProgress = new Set<string>()

async function fetch(url: string, init?: RequestInit): Promise<Response> {
  fetchInProgress.add(url)
  try {
    const response = await global.fetch(url, init)
    return response
  } finally {
    fetchInProgress.delete(url)
  }
}

type Person = {
  name: string
}

async function fetchPerson(id: number, signal?: AbortSignal): Promise<Person> {
  const response = await fetch(`https://swapi.info/api/people/${id}`, {
    signal,
  })
  const person = (await response.json()) as Person
  return person
}

async function fail() {
  throw new Error("Fail!")
}

const abortController = new AbortController()
try {
  await Promise.all([
    fetchPerson(1, abortController.signal),
    fetchPerson(2, abortController.signal),
    fetchPerson(3, abortController.signal),
    fail(),
  ])
} catch (error) {
  // abortController.abort()
  console.log(error)
}

setImmediate(() => console.log(fetchInProgress))

import {
  main,
  type Operation,
  race,
  sleep,
  until,
  useAbortSignal,
} from "effection"

type Person = {
  name: string
  height: string
  mass: string
  hair_color: string
  skin_color: string
  eye_color: string
  birth_year: string
  gender: string
  homeworld: string
  films: string[]
  species: string[]
  vehicles: string[]
  starships: string[]
  created: string
  edited: string
  url: string
}

function* fetchPerson(id: number): Operation<Person> {
  const signal = yield* useAbortSignal()
  const response = yield* until(
    fetch(`https://swapi.info/api/people/${id}`, { signal }),
  )
  const person = yield* until(response.json() as Promise<Person>)
  return person
}

function* delayTimeout<T = void>(delay: number): Operation<T> {
  yield* sleep(delay)
  throw new Error(`Timed out after ${delay}ms`)
}

function withTimeout<T>(operation: Operation<T>, delay: number): Operation<T> {
  return race([operation, delayTimeout<T>(delay)])
}

await main(function* () {
  const person = yield* withTimeout(fetchPerson(69), 1000)
  console.log(`Name: ${person.name}`)
})

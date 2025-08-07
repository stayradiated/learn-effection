import { $ } from "execa"

const llm = {
  prompt: async (prompt: string): Promise<string> => {
    const result = await $`llm ${prompt}`
    return result.stdout.trim()
  },
}

type StringGenerator = Generator<
  // the type of values that will be `yield`ed
  Promise<string> | StringGenerator,
  // the function return value
  string,
  // the type of values can be passed to `.next()`
  string
>

function* suggestFavouriteFood(name: string): StringGenerator {
  const result = yield llm.prompt(
    `You have just met a person with the name "${name}". What might be their favourite food? Be creative! Respond ONLY with the name of the food in quotes and nothing else. For example '"sundried tomatoes"'.`,
  )
  return JSON.parse(result) // strip double quotes
}

function* greet(name: string): StringGenerator {
  let food: string
  try {
    food = yield suggestFavouriteFood(name)
  } catch (_error) {
    food = "pizza"
  }
  return `Hello ${name}, would you like to try some ${food}?`
}

async function run(gen: StringGenerator): Promise<string> {
  let cmd: ["next", string] | ["throw", unknown] = ["next", ""]

  while (true) {
    const result: IteratorResult<Promise<string> | StringGenerator, string> =
      cmd[0] === "next" ? gen.next(cmd[1]) : gen.throw(cmd[1])

    if (result.done) {
      return result.value
    }

    try {
      if (result.value instanceof Promise) {
        cmd = ["next", await result.value]
      } else {
        cmd = ["next", await run(result.value)]
      }
    } catch (error) {
      cmd = ["throw", error]
    }
  }
}

console.log(await run(greet("Meks")))

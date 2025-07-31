import * as childProcess from "node:child_process"
import process from "node:process"
import Database from "better-sqlite3"
import {
  action,
  all,
  createContext,
  type Operation,
  resource,
  run,
} from "effection"

type JobStatus = "pending" | "running" | "done" | "failed"

type Job = {
  id: number
  command: string
  args: string[]
  status: JobStatus
  started_at: Date | null
  finished_at: Date | null
  stdout: string | null
  stderr: string | null
}

type SerializedJob = Omit<Job, "args" | "started_at" | "finished_at"> & {
  args: string
  started_at: string | null
  finished_at: string | null
}

const WorkerName = createContext<string>("WorkerName")

function useDatabase(path: string): Operation<Database.Database> {
  return resource(function* (provide) {
    const db = new Database(path)

    db.pragma(`journal_mode = WAL`)

    db.exec(`
DROP TABLE IF EXISTS jobs;
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  command TEXT NOT NULL,
  args TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  started_at DATETIME,
  finished_at DATETIME,
  stdout TEXT,
  stderr TEXT
);
    `)

    try {
      // Provide the database connection to the consumer
      yield* provide(db)
    } finally {
      // Cleanup runs automatically when the resource is closed
      db.close()
      console.log("Database connection closed")
    }
  })
}

function seedJobs(db: Database.Database): void {
  const count = db
    .prepare<
      [],
      {
        c: number
      }
    >("SELECT count(*) AS c FROM jobs")
    .get()?.c
  if (typeof count !== "number") {
    throw new Error("Failed to retrieve job count from the database")
  }
  if (count > 0) {
    console.log("Jobs table already seeded")
    return
  }
  const insert = db.prepare<[string, string], void>(`
INSERT INTO jobs (command, args, status)
VALUES (?, json(?), 'pending')
  `)
  const jobs: Pick<Job, "command" | "args">[] = [
    { command: "echo", args: ["Hello, World!"] },
    { command: "ls", args: ["-l"] },
    { command: "sleep", args: ["5"] },
    { command: "date", args: [] },
    { command: "uptime", args: [] },
  ]
  for (const job of jobs) {
    insert.run(job.command, JSON.stringify(job.args))
  }
  console.log("Jobs table seeded with initial data")
}

function printJobs(db: Database.Database): void {
  const select = db.prepare<[], SerializedJob>(`
SELECT id, command, args, status, started_at, finished_at, stdout, stderr
FROM jobs
ORDER BY id
  `)
  const jobs = select.all()
  if (jobs.length === 0) {
    console.log("No jobs found in the database")
    return
  }
  console.log("Jobs in the database:")
  for (const job of jobs) {
    const id = job.id.toString()
    const commandArgs = `${job.command} ${job.args}`
    const status = job.status
    const startedAt = job.started_at
      ? new Date(job.started_at).toISOString()
      : "N/A"
    const finishedAt = job.finished_at
      ? new Date(job.finished_at).toISOString()
      : "N/A"
    const stdout = job.stdout ? job.stdout.trim() : ""
    const stderr = job.stderr ? job.stderr.trim() : ""
    console.log(
      `${id.padStart(10)} | ${commandArgs.padEnd(20)} | ${status.padEnd(10)} | Started: ${startedAt} | Finished: ${finishedAt} | Stdout: ${stdout} | Stderr: ${stderr}`,
    )
  }
}

function sweepStaleJobs(db: Database.Database): void {
  db.exec(`
UPDATE jobs
SET status = 'failed', stderr = 'Job timed out'
WHERE status = 'running' AND started_at < datetime('now', '-10 seconds')
  `)
  console.log("Stale jobs have been swept")
}

function claimNextJob(db: Database.Database): Job | undefined {
  return db
    .transaction(() => {
      const job = db
        .prepare<[], SerializedJob>(`
UPDATE jobs
SET
  STATUS = 'running',
  started_at = CURRENT_TIMESTAMP
WHERE id = (
  SELECT id
  FROM jobs
  WHERE STATUS = 'pending'
  ORDER BY id ASC
  LIMIT 1
)
RETURNING *
    `)
        .get()
      if (!job) {
        return undefined
      }

      return {
        ...job,
        args: JSON.parse(job.args),
        started_at: job.started_at ? new Date(job.started_at) : null,
        finished_at: job.finished_at ? new Date(job.finished_at) : null,
        stdout: job.stdout || null,
        stderr: job.stderr || null,
      }
    })
    .default()
}

function updateJob(db: Database.Database, job: Job): undefined {
  return db
    .transaction(() => {
      db.prepare<
        Pick<
          SerializedJob,
          "id" | "status" | "finished_at" | "stdout" | "stderr"
        >,
        SerializedJob
      >(`
UPDATE jobs
SET
  status = :status,
  finished_at = :finished_at,
  stdout = :stdout,
  stderr = :stderr
WHERE
  id = :id
RETURNING *
   `).run({
        id: job.id,
        status: job.status,
        finished_at: job.finished_at?.toISOString() ?? null,
        stdout: job.stdout,
        stderr: job.stderr,
      })
      return undefined
    })
    .default()
}

function spawnJob(job: Job) {
  return action<Job>((resolve) => {
    let stdout = ""
    let stderr = ""
    const child = childProcess.spawn(job.command, job.args)

    child.stdout.on("data", (data) => {
      stdout += data.toString()
    })
    child.stderr.on("data", (data) => {
      stderr += data.toString()
    })
    child.on("close", (code) => {
      resolve({
        ...job,
        status: code === 0 ? "done" : "failed",
        finished_at: new Date(),
        stdout,
        stderr,
      })
    })

    return () => {
      // teardown function always runs
      // even when app is ctrl+c'd
      child.kill()
    }
  })
}

const isShuttingDown = false

function* createWorkerLoop(db: Database.Database): Operation<undefined> {
  const workerName = yield* WorkerName.expect()
  console.log(`[${workerName}]: Starting Worker`)
  while (true) {
    if (isShuttingDown) {
      break
    }

    const job = claimNextJob(db)
    if (!job) {
      break
    }
    console.log(
      `[${workerName}]: Running Job ${job.id} (${job.command} ${job.args.join(" ")})`,
    )
    const updatedJob = yield* spawnJob(job)
    updateJob(db, updatedJob)
    console.log(`[${workerName}]: Completed Job ${job.id}`)
  }
  return undefined
}

// function* gracefulShutdown() {
//   let count = 0
//
//   yield* action<void>(() => {
//     function onSigint() {
//       if (count === 0) {
//         count += 1
//         isShuttingDown = true
//         console.log("\n⌨️  Ctrl-C received. Finishing in-flight jobs…")
//         console.log("    (Press Ctrl-C again to force-quit)")
//       } else if (count === 1) {
//         console.log("\n💥  Hard exit.")
//         process.exit(1)
//       }
//     }
//     process.on("SIGINT", onSigint)
//
//     return () => {
//       process.off("SIGINT", onSigint)
//     }
//   })
// }

type Exit = {
  status: number
  message?: string
  signal?: string
  error?: Error
}

const ExitContext = createContext<(exit: Exit) => void>("exit")

function* exit(status: number, message?: string): Operation<void> {
  const onExit = yield* ExitContext.expect()
  onExit({ status, message })
}

async function main(body: (args: string[]) => Operation<void>): Promise<void> {
  const result = await run(() =>
    action<Exit>(function* (resolve) {
      // action will return shutdown immediately upon resolve, so stash
      // this function in the exit context so it can be called anywhere.
      yield* ExitContext.set(resolve)

      // this will hold the event loop and prevent runtimes such as
      // Node and Deno from exiting prematurely.
      const interval = setInterval(() => {}, 2 ** 30)

      try {
        const interrupt = {
          SIGINT: () => resolve({ status: 130, signal: "SIGINT" }),
          SIGTERM: () => resolve({ status: 143, signal: "SIGTERM" }),
        }

        try {
          process.on("SIGINT", interrupt.SIGINT)
          process.on("SIGTERM", interrupt.SIGTERM)
          yield* body(process.argv.slice(2))
        } finally {
          process.off("SIGINT", interrupt.SIGINT)
          process.off("SIGTERM", interrupt.SIGINT)
        }

        yield* exit(0)
      } catch (error) {
        resolve({ status: 1, error: error as Error })
      } finally {
        clearInterval(interval)
      }
    }),
  )

  if (result.message) {
    if (result.status === 0) {
      console.log(result.message)
    } else {
      console.error(result.message)
    }
  }

  if (result.error) {
    console.error(result.error)
  }

  process.exit(result.status)
}

await main(function* () {
  const db = yield* useDatabase("jobs.db")
  console.log("Database connection established")

  sweepStaleJobs(db)
  console.log("Stale jobs swept")

  seedJobs(db)
  printJobs(db)

  const workers = Array.from({ length: 3 }).map(
    function* (_, index): Operation<undefined> {
      yield* WorkerName.set(`Worker ${index + 1}`)
      yield* createWorkerLoop(db)
    },
  )
  yield* all(workers)

  printJobs(db)
})

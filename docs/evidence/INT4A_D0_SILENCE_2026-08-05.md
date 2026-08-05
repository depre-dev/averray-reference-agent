# INT-4a D0 silence baseline — 2026-08-05

This drill ran against unmodified `main` at
`1fa532322ce333c82519ca8ac66424670b9fbedd` before any watchdog code existed.
It used the isolated local Compose project `codex-int4a-d0-42713`, two
throwaway Postgres containers, a host-side dispatcher built from that commit,
and a localhost fake sink. It did not start, stop, or inspect the production
`avg` project and used no real credential.

The two authenticated `select 1` results prove both databases were live. The
dispatcher PID remained signalable while its heartbeat advanced from
`2026-08-05T09:19:43.852Z` to `2026-08-05T09:19:48.862Z`, proving the process
was alive before either injection. The Harness database stop command returned
success; Compose's default `ps` view reports a stopped service as `missing`,
which is the `state=missing` value below.

The fake sink was listening before the injections. After the Harness database
was stopped, and again after the dispatcher was terminated, neither the local
dispatcher alert stream nor the external sink received a record. This is the
red silence INT-4a exists to turn green.

```text
D0_MAIN_SHA=1fa532322ce333c82519ca8ac66424670b9fbedd
D0_LOCAL_COMPOSE_PROJECT=codex-int4a-d0-42713
D0_FAKE_SINK_LIVE=true pid=42723 port=52908
D0_REFERENCE_DB_LIVE=1
D0_HARNESS_DB_LIVE=1
D0_DISPATCHER_LIVE=true pid=42785
D0_HEARTBEAT_ONE=2026-08-05T09:19:43.852Z
D0_HEARTBEAT_TWO=2026-08-05T09:19:48.862Z
D0_HEARTBEAT_ADVANCING=true
D0_HARNESS_DB_STOPPED=true state=missing
D0_DB_DOWN_DISPATCHER_STILL_LIVE=true
D0_DB_DOWN_ALERT_FILE_DELTA=0
D0_DB_DOWN_EXTERNAL_DELIVERY_DELTA=0
D0_DB_DOWN_SILENCE=true
D0_DISPATCHER_KILLED=true pid_alive=false
D0_DISPATCHER_KILLED_ALERT_FILE_DELTA=0
D0_DISPATCHER_KILLED_EXTERNAL_DELIVERY_DELTA=0
D0_DISPATCHER_KILLED_SILENCE=true
D0_RESULT=red_silence_confirmed
```

The local project and volumes were removed by the drill cleanup.

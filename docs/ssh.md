# `grok ssh`

Wraps `ssh` so OSC 52 clipboard sequences from the remote shell get written to your local clipboard. On terminals with native OSC 52 support it falls through to a plain `ssh exec`; on terminals without it (Apple Terminal in particular) grok installs a PTY wrapper that intercepts clipboard escape sequences and routes them to your local system clipboard.

Captured from `grok ssh --help` against grok 0.1.212.

## Shape

```
grok ssh <SSH_ARG>...
```

Everything after `grok ssh` is forwarded straight to `ssh` (or to grok's PTY shim, depending on the terminal).

## Arguments

| Arg | Description |
|---|---|
| `<SSH_ARG>...` | Standard ssh arguments: `user@host`, `-p 2222`, `-i ~/.ssh/key`, `-t`, `-L 8080:localhost:80`, etc. |

## Examples

```sh
# Same as ssh -t, but anything yanked on the remote ends up on your local clipboard
grok ssh dan@dev.example.com

# With a port and key as usual
grok ssh -i ~/.ssh/laptop -p 2222 dan@dev.example.com

# Multi-hop and port forward both work because args are passed through
grok ssh -J jump@bastion dan@db -L 5432:localhost:5432
```

## When it does what

| Local terminal | Behavior |
|---|---|
| Native OSC 52 (kitty, WezTerm, iTerm2 with the option enabled, recent Terminal.app builds) | Plain `ssh` exec; no wrapping. |
| No OSC 52 (Apple Terminal default, some embedded SSH UIs) | PTY shim that intercepts clipboard escape sequences and writes to the local clipboard. |

See `~/.grok/README.md` for the details on how the shim distinguishes.

## Notes

- Pasting *from* your local clipboard into the remote is whatever your terminal already does; this command only fixes the reverse direction.
- Outside of OSC 52 there's nothing grok-specific here, so feel free to alias if you want it on by default: `alias ssh='grok ssh'`.

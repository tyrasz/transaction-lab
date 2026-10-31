"""Fixed CPU-bound exec wrapper. The archived driver binds the exact argv.

The CPU limit is inherited by children, per process, not an aggregate group
CPU or memory limit. Wall time, stream caps and group cleanup belong to the
driver. No environment, command or code is read from transaction input.
"""
import os
import resource
import sys

if not sys.flags.isolated or not sys.dont_write_bytecode or len(sys.argv) < 3:
    raise ValueError("Use isolated Python and an absolute executable")
if not os.path.isabs(sys.argv[1]) or not os.path.isfile(sys.argv[1]):
    raise ValueError("Expected absolute executable")
resource.setrlimit(resource.RLIMIT_CPU, (15, 15))
os.execv(sys.argv[1], sys.argv[1:])

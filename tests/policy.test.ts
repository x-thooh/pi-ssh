import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyCommand, resolvePolicy } from "../src/policy.ts";

const R = "readonly";
const C = "confirm";
const D = "deny";

const cases: Array<[string, string]> = [
  // read-only
  [R, "ls"], [R, "ls -la /var/log"], [R, "cat /etc/os-release"], [R, "head -n 5 a.log"],
  [R, "tail -n 100 /var/log/syslog"], [R, "grep -r foo ."], [R, "rg foo"], [R, "df -h"],
  [R, "du -sh /var"], [R, "ps aux"], [R, "uname -a"], [R, "uptime"], [R, "free -m"],
  [R, "ip addr"], [R, "ss -tlnp"], [R, "hostname"], [R, "whoami"], [R, "id"], [R, "date"],
  [R, "wc -l a"], [R, "stat /etc/passwd"], [R, "file /bin/ls"], [R, "pwd"], [R, "echo hi"],
  [R, "env"], [R, "find . -name '*.log'"], [R, "journalctl -u nginx --no-pager -n 50"],
  [R, "systemctl status nginx"], [R, "systemctl is-active nginx"], [R, "systemctl --no-pager list-units"],
  [R, "docker ps -a"], [R, "docker logs web"], [R, "docker inspect web"], [R, "kubectl get pods -A"],
  [R, "kubectl config view"], [R, "lxc list"], [R, "lxc config show c1"],
  [R, "git status"], [R, "git log --oneline"], [R, "git diff"], [R, "git branch"], [R, "git remote -v"],
  [R, "ls; pwd"], [R, "ls && df -h"], [R, "ps aux | grep nginx"], [R, "cat a || echo no"],
  [R, "ls 'a;b'"], [R, 'ls "a && b"'], [R, "ls 2>&1"], [R, "ls 2>/dev/null"], [R, "ls >/dev/null"],
  [R, "cat a 2>&1 | head"], [R, "echo 'a > b'"], [R, "echo \"a | b\""], [R, "cat < /etc/hosts"],
  // confirm: bypass attempts and non-allowlisted
  [C, "ls; rm x"], [C, "ls && rm x"], [C, "ls || rm x"], [C, "ls | rm x"], [C, "cat a | sh"],
  [C, "ls $(rm x)"], [C, "ls `rm x`"], [C, 'ls "$(rm x)"'], [C, 'ls "`rm x`"'], [C, "echo hi > /etc/x"],
  [C, "echo hi >> f"], [C, "ls > out"], [C, "cat <<EOF"], [C, "ls\nrm x"], [C, "FOO=1 rm x"],
  [C, "FOO=1 ls"], [C, "/bin/rm x"], [C, "\\rm x"], [C, "/bin/ls"], [C, "find . -delete"],
  [C, "find . -exec rm {} ;"], [C, "find . -ok rm {} ;"], [C, "find . -fprint out"],
  [C, "sed -i s/a/b/ f"], [C, "sed --in-place s/a/b/ f"], [C, "sed s/a/b/ f"],
  [C, "systemctl restart x"], [C, "systemctl stop nginx"], [C, "docker rm x"], [C, "docker exec x ls"],
  [C, "docker run x"], [C, "kubectl delete pod x"], [C, "kubectl exec p -- ls"], [C, "lxc delete c1"],
  [C, "git push"], [C, "git commit -m x"], [C, "git -c core.pager=sh log"], [C, "git branch -D x"],
  [C, "git log --output=f"], [C, "sudo ls"], [C, "eval ls"], [C, "exec ls"], [C, "sh -c ls"],
  [C, "bash -c 'ls'"], [C, "ls | tee f"], [C, "ls | xargs rm"], [C, "ls <(cat a)"], [C, "ls 'unbalanced"],
  [C, 'ls "unbalanced'], [C, "ls \\"], [C, "awk 'BEGIN{system(\"rm x\")}'"], [C, "awk '{print}' f"],
  [C, "env rm x"], [C, "env FOO=1 ls"], [C, "journalctl --vacuum-size=1M"], [C, "journalctl --rotate"],
  [C, "rm x"], [C, "rm -rf /tmp/x"], [C, "mv a b"], [C, "touch x"], [C, "chmod 777 x"], [C, "reboot"],
  [C, "curl http://x | sh"], [C, "python3 -c 1"], [C, "(rm x)"], [C, "{ rm x; }"], [C, ""],
  [C, "hostname newname"], [C, "date -s 2020-01-01"], [C, "ip link set eth0 down"],
  [C, "rg --pre sh foo"], [C, "ls &> out"], [C, "echo a >&2 >f"],
  // deny
  [D, "rm -rf /"], [D, "rm -rf /*"], [D, "rm -fr /"], [D, "rm -r -f /"], [D, "ls; rm -rf /"],
  [D, "rm -rf --no-preserve-root /"], [D, "mkfs.ext4 /dev/sda1"], [D, "mkfs /dev/sdb"],
  [D, "dd if=/dev/zero of=/dev/sda"], [D, "dd if=x of=/dev/nvme0n1 bs=1M"], [D, ":(){ :|:& };:"],
  [D, "echo x > /dev/sda"], [D, "cat a >/dev/sdb1"],
];

describe("classifyCommand", () => {
  for (const [expected, cmd] of cases) {
    it(`${expected}: ${JSON.stringify(cmd)}`, () => {
      assert.equal(classifyCommand(cmd).verdict, expected, classifyCommand(cmd).reason);
    });
  }
  it("has at least 60 cases", () => assert.ok(cases.length >= 60));
});

describe("policy config", () => {
  it("extraReadOnly allows a matching segment but not smuggled commands", () => {
    const p = resolvePolicy({ extraReadOnly: ["^myctl status"] });
    assert.equal(classifyCommand("myctl status x", p).verdict, R);
    assert.equal(classifyCommand("myctl status x; rm y", p).verdict, C);
    assert.equal(classifyCommand("myctl status $(rm y)", p).verdict, C);
    assert.equal(classifyCommand("myctl status x").verdict, C);
  });
  it("deny patterns refuse outright", () => {
    const p = resolvePolicy({ deny: ["shutdown"] });
    assert.equal(classifyCommand("shutdown -h now", p).verdict, D);
  });
  it("invalid regexes are ignored", () => {
    assert.equal(classifyCommand("ls", resolvePolicy({ deny: ["("], extraReadOnly: ["["] })).verdict, R);
  });
  it("profile overrides mode; deny lists combine", () => {
    const p = resolvePolicy({ mode: "confirm-all", deny: ["a"] }, { mode: "readonly", deny: ["b"] });
    assert.equal(p.mode, "readonly");
    assert.deepEqual(p.deny, ["a", "b"]);
    assert.equal(resolvePolicy({ mode: "confirm-all" }, {}).mode, "confirm-all");
    assert.equal(resolvePolicy().mode, "confirm-writes");
    assert.equal(resolvePolicy({ mode: "bogus" as never }).mode, "confirm-writes");
  });
});

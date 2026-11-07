//! The shipped bounds, pools, runner configuration and dispatch.yml steps of
//! this repository. Where a check pins a file's text, a line as written, it
//! reads the text; where it reads values, it parses the TOML or JSON.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::{Value, json};

const MARKER: &str = "# The experiment's own tables; everything above is hosted.toml's.\n";

/// The agents that load skills; a pool of any other runs the `-full` profiles.
const SKILLED_AGENTS: [&str; 2] = ["claude", "opencode"];

const KINDS: [&str; 5] = ["implement", "fix", "triage", "research", "review"];

/// `.github/agentic-job`, which the files are named relative to.
fn here() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn read(name: &str) -> String {
    let path = here().join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("reading {}: {e}", path.display()))
}

fn json_file(name: &str) -> Value {
    serde_json::from_str(&read(name)).unwrap_or_else(|e| panic!("parsing {name}: {e}"))
}

fn pools() -> serde_json::Map<String, Value> {
    match json_file("pools.json") {
        Value::Object(pools) => pools,
        other => panic!("pools.json is not an object: {other}"),
    }
}

fn dispatch() -> String {
    read("../workflows/dispatch.yml")
}

#[test]
fn weekly_blog_passes_deployment_settings_and_partial_to_digest() {
    let config = json_file("../weekly-digest.json");
    let board = json_file("../poll/agent-board.json");
    for key in ["operator", "bot", "follow"] {
        assert_eq!(config[key], board[key], "{key}");
    }
    let pass = json_file("../pass.json");
    assert_eq!(config["owner"], pass["board"]["owner"]);
    assert_eq!(config["project"], pass["board"]["project"]);
    for (key, expected) in [
        ("siteRepository", json!("cgwalters-forge/cgwalters-forge.github.io")),
        ("title", json!("Weekly notes: week ending {week}")),
        ("priority", json!("P0")),
        ("changesChars", json!(26000)),
        ("releaseBytes", json!(10000)),
        ("bodyBytes", json!(56000)),
        ("dispatchRepository", pass["dispatchRepo"].clone()),
        ("dispatchWorkflow", json!("dispatch.yml")),
        ("dispatchRef", json!("main")),
    ] {
        assert_eq!(config[key], expected, "{key}");
    }
    let workflow = read("../workflows/weekly-blog.yml");
    for setting in [
        "GH_TOKEN: ${{ secrets.CGWALTERS_BOT_PAT }}",
        "DISPATCH_TOKEN: ${{ github.token }}",
        "PARTIAL: ${{ inputs.partial }}",
        "vars.WEEKLY_BLOG == 'enabled'",
        "cancel-in-progress: false",
    ] {
        assert!(workflow.contains(setting), "{setting}");
    }
    let script = workflow.rsplit_once("        run: |\n").expect("digest step").1;
    for (partial, suffix) in [("", ""), ("false", ""), ("true", "--partial\n")] {
        let output = Command::new("bash")
            .args(["--noprofile", "--norc", "-euo", "pipefail", "-c",
                &format!("digest_cli() {{ printf '%s\\n' \"$@\"; }}\n{script}")])
            .env("AGENT_BOARD", "digest_cli")
            .env("PARTIAL", partial)
            .output().expect("run digest step with mocked CLI");
        assert!(output.status.success(), "{output:?}");
        assert_eq!(String::from_utf8(output.stdout).unwrap(),
            format!("digest\n--config\n.github/weekly-digest.json\n{suffix}--apply\n"));
    }
}

fn profile(name: &str) -> String {
    read(&format!("profiles/{name}.md"))
}

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v
}

/// Whether `lines` stand in `text` one after another as whole lines.
fn has_lines(text: &str, lines: &[&str]) -> bool {
    format!("\n{text}\n").contains(&format!("\n{}\n", lines.join("\n")))
}

fn has_line(text: &str, line: &str) -> bool {
    has_lines(text, &[line])
}

/// Whether a line of `text` starts with `prefix`.
fn has_line_starting(text: &str, prefix: &str) -> bool {
    text.lines().any(|l| l.starts_with(prefix))
}

/// The lines that start with exactly `indent` spaces followed by one of `keys`.
fn indented<'t>(text: &'t str, indent: usize, keys: &[&str]) -> Vec<&'t str> {
    let pad = " ".repeat(indent);
    text.lines()
        .filter(|l| l.strip_prefix(&pad).is_some_and(|r| keys.iter().any(|k| r.starts_with(k))))
        .collect()
}

/// `text` without the newline-terminated lines that `drop` picks.
fn drop_lines(text: &str, drop: impl Fn(&str) -> bool) -> String {
    text.split_inclusive('\n')
        .filter(|l| !(l.ends_with('\n') && drop(l)))
        .collect()
}

/// `text` with its first line equal to `from` replaced by `to`, or removed
/// with its newline.
fn replace_line(text: &str, from: &str, to: Option<&str>) -> String {
    let mut done = false;
    let out: Vec<&str> = text
        .split('\n')
        .filter_map(|l| match !done && l == from {
            true => {
                done = true;
                to
            }
            false => Some(l),
        })
        .collect();
    assert!(done, "no line {from:?}");
    out.join("\n")
}

/// `text` up to its first line that starts a table.
fn before_table(text: &str) -> &str {
    let mut at = 0;
    for line in text.split_inclusive('\n') {
        if line.starts_with('[') {
            break;
        }
        at += line.len();
    }
    &text[..at]
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Whether `word` stands in `text` as a whole word.
fn has_word(text: &str, word: &str) -> bool {
    text.match_indices(word).any(|(i, _)| {
        !text[..i].ends_with(is_word) && !text[i + word.len()..].starts_with(is_word)
    })
}

/// Whether `text` contains `parts` in this order.
fn in_order(text: &str, parts: &[&str]) -> bool {
    let mut rest = text;
    parts.iter().all(|p| match rest.find(p) {
        Some(i) => {
            rest = &rest[i + p.len()..];
            true
        }
        None => false,
    })
}

/// The `[github.outputs]` table of a bounds file, as written.
fn outputs(name: &str) -> String {
    let text = read(name);
    let (_, after) = text
        .split_once("[github.outputs]\n")
        .unwrap_or_else(|| panic!("{name} has no [github.outputs]"));
    before_table(after).to_owned()
}

/// The `key = value` lines of a `[github.outputs]` table, in order.
fn output_entries(outputs: &str) -> Vec<(&str, &str)> {
    outputs
        .lines()
        .filter_map(|l| {
            let key_len = l.find(|c: char| !(c.is_ascii_lowercase() || c == '_'))?;
            let value = l[key_len..].strip_prefix(" = ")?;
            (key_len > 0 && !value.is_empty()).then_some((&l[..key_len], value))
        })
        .collect()
}

fn toml_file(name: &str) -> toml::Table {
    read(name)
        .parse()
        .unwrap_or_else(|e| panic!("parsing {name}: {e}"))
}

fn strings(v: &toml::Value, what: &str) -> Vec<String> {
    v.as_array()
        .unwrap_or_else(|| panic!("{what} is not an array"))
        .iter()
        .map(|s| s.as_str().unwrap_or_else(|| panic!("{what} has a non-string")).to_owned())
        .collect()
}

/// A bounds file's targets.
fn repos(name: &str) -> Vec<String> {
    let table = toml_file(name);
    strings(table.get("repos").unwrap_or_else(|| panic!("{name} has no repos")), name)
}

/// Each `repos` list of a bounds file: its targets, then its unprotected files'.
fn lists(name: &str) -> Vec<Vec<String>> {
    fn walk(table: &toml::Table, name: &str, out: &mut Vec<Vec<String>>) {
        for (key, value) in table {
            match value {
                toml::Value::Table(t) => walk(t, name, out),
                v if key == "repos" => out.push(strings(v, name)),
                _ => {}
            }
        }
    }
    let mut out = vec![];
    walk(&toml_file(name), name, &mut out);
    out
}

/// The lines of `text` split at each line equal to `line`.
fn sections(text: &str, line: &str) -> Vec<String> {
    let mut out = vec![String::new()];
    for l in text.split_inclusive('\n') {
        match l.trim_end_matches('\n') == line {
            true => out.push(String::new()),
            false => out.last_mut().unwrap().push_str(l),
        }
    }
    out
}

/// A run step of dispatch.yml: the lines of its `run: |` block, unindented.
fn step_script(name: &str) -> String {
    let dispatch = dispatch();
    let lines: Vec<&str> = dispatch.split('\n').collect();
    let start = format!("      - name: {name}");
    let pad = " ".repeat(10);
    let found = lines.iter().enumerate().filter(|(_, l)| **l == start).find_map(|(i, _)| {
        let mut j = i + 1;
        while *lines.get(j)? != "        run: |" {
            lines[j].strip_prefix("        ")?;
            j += 1;
        }
        let body: Vec<&str> = lines[j + 1..]
            .iter()
            .take_while(|l| l.is_empty() || l.starts_with(&pad))
            .map(|l| l.strip_prefix(&pad).unwrap_or(l))
            .collect();
        (!body.is_empty()).then(|| body.join("\n") + "\n")
    });
    found.unwrap_or_else(|| panic!("no run step {name} in dispatch.yml"))
}

/// A fresh path under the build's own temporary directory.
fn temp_path(name: &str) -> PathBuf {
    static COUNT: AtomicUsize = AtomicUsize::new(0);
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("config-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("creating the temporary directory");
    dir.join(format!("{}-{name}", COUNT.fetch_add(1, Ordering::Relaxed)))
}

/// What bash running `script` with `env` writes to GITHUB_OUTPUT, or why it failed.
fn run_step(script: &str, env: &[(&str, &str)]) -> Result<String, String> {
    let out = temp_path("output");
    std::fs::write(&out, "").expect("creating GITHUB_OUTPUT");
    let run = Command::new("bash")
        .args(["-eo", "pipefail", "-c", script])
        .current_dir(here().join("../.."))
        .envs(env.iter().copied())
        .env("GITHUB_OUTPUT", &out)
        .output()
        .expect("running bash");
    match run.status.success() {
        true => Ok(std::fs::read_to_string(&out).expect("reading GITHUB_OUTPUT")),
        false => Err(String::from_utf8_lossy(&run.stderr).into_owned()),
    }
}

/// The check the wrapper's policy job makes, with the settings it adds for
/// a real agent; where agentic-job is not installed (CI) it is skipped.
fn agentic_job_installed() -> bool {
    let ok = Command::new("agentic-job")
        .arg("--version")
        .output()
        .is_ok_and(|o| o.status.success());
    if !ok {
        eprintln!("skipped: agentic-job is not installed");
    }
    ok
}

fn agentic_job(args: &[&str]) -> Output {
    Command::new("agentic-job")
        .args(args)
        .output()
        .expect("running agentic-job")
}

/// agentic-job's standard output, which must succeed.
fn agentic_job_ok(args: &[&str]) -> String {
    let out = agentic_job(args);
    assert!(out.status.success(), "agentic-job {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).expect("agentic-job's output is UTF-8")
}

fn path_of(name: &str) -> String {
    here().join(name).to_string_lossy().into_owned()
}

#[test]
fn acp_experiment_is_hosted_and_a_child_agent_and_hosted_has_none() {
    let hosted = read("hosted.toml");
    let experiment = read("acp-experiment.toml");
    let body = |text: &str| text[text.find("[sandbox]\n").expect("a [sandbox] table")..].to_owned();
    let (hosted_body, experiment_body) = (body(&hosted), body(&experiment));
    let mut parts = experiment_body.split(MARKER);
    let copy = parts.next().unwrap_or_default();
    let own = parts.next().expect("the marker before the experiment's own tables");
    assert_eq!(copy, format!("{hosted_body}\n"), "acp-experiment.toml must keep hosted.toml unchanged");
    assert!(!has_line_starting(&hosted, "[child-agent]"));
    assert!(has_lines(own, &["[child-agent]", r#"name = "vibe""#, r#"model = "zai-glm-5-3""#]));
    assert!(has_lines(own, &["[limits]", "max-requests = 400"]));
    // Every run on the mistral pool, main agent or child, gets GLM a window
    // well over Vibe's 32k default (#651); the copy above holds both files to it.
    assert!(has_lines(&hosted, &["[agent.context-windows]", r#""zai-glm-5-3" = 131072"#]));
    // The child's model is the mistral pool's, the one dispatch can select.
    assert_eq!(pools()["mistral"]["model"], "zai-glm-5-3");
}

// A Rust target's run gets the distribution's rustfmt and clippy with cargo
// (agentic-job 2159c17); acp-experiment.toml's copy is held to hosted.toml above.
#[test]
fn every_rust_target_gets_rustfmt_and_clippy_with_cargo() {
    let hosted = toml_file("hosted.toml");
    let entries = hosted["setup"]["repo-packages"].as_table().expect("[setup.repo-packages]");
    assert_eq!(
        strings(&entries["cgwalters-forge/agenthome"], "agenthome"),
        ["cargo", "rustfmt", "rust-clippy"]
    );
    for (repo, packages) in entries {
        let packages = strings(packages, repo);
        if packages.iter().any(|p| p == "cargo") {
            assert_eq!(packages.iter().take(3).collect::<Vec<_>>(), ["cargo", "rustfmt", "rust-clippy"], "{repo}");
        } else {
            assert!(!packages.iter().any(|p| p == "rustfmt" || p == "rust-clippy"), "{repo}");
        }
    }
    assert_eq!(
        strings(&entries["cgwalters-forge/bootc"], "bootc")[3..],
        ["pkg-config", "libssl-dev", "libostree-dev", "libglib2.0-dev", "libzstd-dev"]
    );
}

// Pool settings may name a tier for its automatic pools (tracker#837), so
// every pool has one; fable's allowance is apart, so only a person spends it.
#[test]
fn every_pool_has_a_tier_and_tier_1_and_tier_2_each_an_automatic_pool() {
    let pools = pools();
    for (name, pool) in &pools {
        assert!(matches!(pool["tier"].as_i64(), Some(1 | 2)), "{name}.tier");
        assert!(pool.get("auto").is_none_or(Value::is_boolean), "{name}.auto");
    }
    let tier = |n: i64| -> Vec<&str> {
        pools
            .iter()
            .filter(|(_, p)| p["tier"].as_i64() == Some(n) && p.get("auto") != Some(&json!(false)))
            .map(|(name, _)| name.as_str())
            .collect()
    };
    assert_eq!(tier(1), ["claude", "openai"]);
    assert_eq!(tier(2), ["mistral"]);
    assert_eq!([&pools["fable"]["tier"], &pools["fable"]["auto"]], [&json!(1), &json!(false)]);
}

#[test]
fn dispatch_passes_the_run_only_a_configuration_from_its_closed_set() {
    let dispatch = dispatch();
    assert_eq!(
        indented(&dispatch, 6, &["config: "]),
        ["      config: ${{ steps.config.outputs.config }}", "      config: ${{ needs.profile.outputs.config }}"]
    );
    assert!(has_lines(
        &dispatch,
        &["        type: choice", "        options: [hosted, acp-experiment]", "        default: hosted"]
    ));
    let step = step_script("Resolve the runner configuration");
    let resolve = |config: &str| run_step(&step, &[("CONFIG", config)]).ok();
    // A normal dispatch leaves the wrapper its default, hosted.toml.
    assert_eq!(resolve("hosted").as_deref(), Some("config=\n"));
    assert_eq!(resolve("acp-experiment").as_deref(), Some("config=.github/agentic-job/acp-experiment.toml\n"));
    for config in ["", "dispatch.toml", ".github/agentic-job/dispatch.toml", "hosted acp-experiment"] {
        assert_eq!(resolve(config), None, "{config}");
    }
}

// A session dispatch of supervisor.yml lets in session.yml's operators and origins.
#[test]
fn supervisor_config_preserves_hosted_sandbox_and_session_without_a_listener() {
    if !agentic_job_installed() {
        return;
    }
    let check = |file: &str| agentic_job_ok(&["config", "--from", &path_of(file), "--host"]);
    let supervisor = check("supervisor.toml");
    let base = check("hosted.toml");
    for table in ["sandbox", "sandbox.check", "setup", "session"] {
        let section = |text: &str| {
            let after = text.split(&format!("[{table}]\n")).nth(1).unwrap_or_else(|| panic!("no [{table}]"));
            after.split("\n[").next().unwrap_or_default().to_owned()
        };
        assert_eq!(section(&supervisor), section(&base), "[{table}]");
    }
    assert!(!supervisor.contains("listen = true"));
}

#[test]
fn agentic_job_config_takes_acp_experiment_and_refuses_it_without_the_cap() {
    if !agentic_job_installed() {
        return;
    }
    let experiment = read("acp-experiment.toml");
    let check = |file: &str| {
        agentic_job(&[
            "config", "--from", file, "--repo", "o/r",
            "--string", "agent.name=claude", "--string", "agent.model=m",
            "--string", "inference.url=http://127.0.0.1:18080", "--string", "inference.register=github-oidc",
            "--string", "inference.audience=a", "--integer", "limits.timeout-minutes=75", "--integer", "limits.budget=500",
        ])
    };
    let ok = check(&path_of("acp-experiment.toml"));
    assert!(ok.status.success(), "{}", String::from_utf8_lossy(&ok.stderr));
    let stdout = String::from_utf8_lossy(&ok.stdout);
    assert!(has_lines(&stdout, &["[child-agent]", r#"model = "zai-glm-5-3""#, r#"name = "vibe""#]), "{stdout}");
    assert!(has_lines(&stdout, &["[agent.context-windows]", "zai-glm-5-3 = 131072"]), "{stdout}");
    // `config` allows up to GLM-5.3's documented 1M (1,048,576) and no more.
    let wide = temp_path("wide.toml");
    std::fs::write(&wide, replace_line(&experiment, r#""zai-glm-5-3" = 131072"#, Some(r#""zai-glm-5-3" = 1048577"#))).unwrap();
    let refused = check(&wide.to_string_lossy());
    assert!(!refused.status.success());
    let stderr = String::from_utf8_lossy(&refused.stderr);
    assert!(
        stderr.contains(r#"agent.context-windows: "zai-glm-5-3" = 1048577, not a number from 1 to 1048576"#),
        "{stderr}"
    );
    let uncapped = temp_path("uncapped.toml");
    std::fs::write(&uncapped, replace_line(&experiment, "max-requests = 400", None)).unwrap();
    let stderr = String::from_utf8_lossy(&check(&uncapped.to_string_lossy()).stderr).into_owned();
    assert!(stderr.contains("child-agent needs limits.max-requests"), "{stderr}");
    let hosted = agentic_job_ok(&[
        "config", "--from", &path_of("hosted.toml"), "--repo", "o/r",
        "--string", "agent.name=fake", "--integer", "limits.timeout-minutes=75", "--boolean", "limits.uncapped=true",
    ]);
    assert!(!hosted.contains("child-agent"));
}

#[test]
fn misctool_is_a_dispatch_and_fix_target_with_matching_workflow_edit_bounds() {
    let dispatch_lists = lists("dispatch.toml");
    let fix_lists = lists("fix.toml");
    for (name, bounds) in [("dispatch", &dispatch_lists), ("fix", &fix_lists)] {
        assert_eq!(bounds.len(), 2, "{name}");
        for repos in bounds {
            assert!(repos.iter().any(|r| r == "cgwalters-forge/misctool"), "{name}");
        }
    }
    // Less the upstreams bootc-dev/* (D17, below) and composefs/composefs-rs, which fix has and dispatch has not.
    for i in 0..2 {
        let fix = fix_lists[i]
            .iter()
            .filter(|r| !["bootc-dev/*", "composefs/composefs-rs"].contains(&r.as_str()))
            .cloned()
            .collect();
        assert_eq!(sorted(dispatch_lists[i].clone()), sorted(fix));
    }
}

// forge-infra (#812) is followed and a target, but no run may edit its
// `.github/` or protected files until a per-repository ruleset is on its
// main; for now the organization's ruleset is its only gate.
#[test]
fn forge_infra_is_a_followed_target_without_unprotected_files() {
    let repo = "cgwalters-forge/forge-infra";
    for name in ["dispatch.toml", "fix.toml", "comment.toml"] {
        assert!(repos(name).iter().any(|r| r == repo), "{name}");
    }
    for name in ["dispatch.toml", "fix.toml"] {
        assert!(!lists(name)[1].iter().any(|r| r == repo), "{name}");
    }
    let follow = json_file("../poll/agent-board.json")["follow"].clone();
    assert!(follow.as_array().expect("agent-board.json's follow").contains(&json!(repo)));
}

#[test]
fn atomic_linux_sandbox_is_a_followed_work_target_not_a_midstream_fork() {
    let repo = "cgwalters-forge/atomic-linux-sandbox";
    for name in ["dispatch.toml", "fix.toml", "comment.toml"] {
        assert!(repos(name).iter().any(|r| r == repo), "{name}");
    }
    for name in ["midstream.toml", "midstream-fix.toml"] {
        assert!(!repos(name).iter().any(|r| r == repo), "{name}");
    }
    let board = json_file("../poll/agent-board.json");
    for list in [&board["follow"], &board["schedule"]["repositories"]] {
        assert!(list.as_array().expect("board repositories").contains(&json!(repo)));
    }
    let pass = json_file("../pass.json");
    for key in ["follow", "workRepositories"] {
        assert!(pass[key].as_array().expect(key).contains(&json!(repo)), "{key}");
    }
    assert!(pass["holds"]["proposals"]["repositories"].as_array().unwrap().contains(&json!(repo)));
    assert!(!pass["pr"]["noMerge"].as_array().unwrap().contains(&json!(repo)));
}

// The midstream fork bcvk takes staged pull requests as composefs-rs and
// bootc do: midstream bounds only, scheduled, followed for fix rounds by the
// pass but never merged into, since its main tracks upstream.
#[test]
fn bcvk_is_a_midstream_target_that_is_never_merged_into() {
    let repo = "cgwalters-forge/bcvk";
    for name in ["midstream.toml", "midstream-fix.toml", "comment.toml"] {
        assert!(repos(name).iter().any(|r| r == repo), "{name}");
    }
    for name in ["dispatch.toml", "fix.toml"] {
        assert!(!repos(name).iter().any(|r| r == repo), "{name}");
    }
    let board = json_file("../poll/agent-board.json");
    assert!(board["schedule"]["repositories"].as_array().expect("schedule.repositories").contains(&json!(repo)));
    assert!(!board["follow"].as_array().expect("agent-board.json's follow").contains(&json!(repo)));
    let pass = json_file("../pass.json");
    for key in ["follow", "workRepositories"] {
        assert!(pass[key].as_array().expect(key).contains(&json!(repo)), "{key}");
    }
    assert!(pass["pr"]["noMerge"].as_array().expect("pr.noMerge").contains(&json!(repo)));
    let proposals = &pass["holds"]["proposals"]["repositories"];
    assert!(proposals.as_array().expect("holds.proposals.repositories").contains(&json!(repo)));
}

#[test]
fn gh_agentic_workflows_has_the_only_midstream_workflow_exception_and_is_never_merged_into() {
    let repo = "cgwalters-forge/gh-agentic-workflows";
    for name in ["midstream.toml", "midstream-fix.toml", "comment.toml"] {
        assert!(repos(name).iter().any(|r| r == repo), "{name}");
    }
    assert!(!has_line_starting(&read("comment.toml"), "[unprotected_files]"));
    for name in ["midstream.toml", "midstream-fix.toml"] {
        let table = toml_file(name);
        let exception = table["unprotected_files"].as_table().expect("workflow exception");
        assert_eq!(exception.len(), 2, "{name}: no protected filename exceptions");
        assert_eq!(strings(&exception["repos"], name), [repo]);
        assert_eq!(strings(&exception["dot_folders"], name), [".github"]);
    }
    for name in ["dispatch.toml", "fix.toml"] {
        for list in lists(name) {
            assert!(!list.iter().any(|r| r == repo), "{name}");
        }
    }
    let pass = json_file("../pass.json");
    for list in [&pass["follow"], &pass["workRepositories"], &pass["pr"]["noMerge"]] {
        assert!(list.as_array().expect("pass repository list").contains(&json!(repo)));
    }
}

#[test]
fn review_gate_discovers_and_deduplicates_all_implement_and_fix_exceptions() {
    let justfile = read("../../Justfile");
    let recipe = justfile.split_once("\nreview-gate-repos:\n").expect("discovery recipe").1
        .lines().next().expect("discovery command").trim().trim_start_matches('@');
    let files = ["dispatch.toml", "fix.toml", "midstream.toml", "midstream-fix.toml"];
    let mut expected = BTreeSet::new();
    for file in files {
        let table = toml_file(file);
        expected.extend(strings(&table["unprotected_files"]["repos"], file));
    }
    let actual = Command::new("just").arg("review-gate-repos").current_dir(here().join("../..")).output().expect("repository discovery");
    assert!(actual.status.success(), "{}", String::from_utf8_lossy(&actual.stderr));
    assert_eq!(String::from_utf8(actual.stdout).unwrap().split_whitespace().collect::<Vec<_>>(), expected.iter().map(String::as_str).collect::<Vec<_>>());
    // Unique sentinels detect a missing source even when today's lists overlap.
    let mut fixture_recipe = recipe.to_owned();
    for (i, file) in files.iter().enumerate() {
        let fixture = temp_path(file);
        std::fs::write(&fixture, format!("[unprotected_files]\nrepos = [\"owner/repo-{i}\", \"owner/shared\"]\n")).unwrap();
        let source = format!(".github/agentic-job/{file}");
        assert!(fixture_recipe.contains(&source), "missing {source}");
        fixture_recipe = fixture_recipe.replace(&source, &format!("'{}'", fixture.display()));
    }
    let actual = Command::new("bash").args(["-euo", "pipefail", "-c", &fixture_recipe]).output().expect("fixture discovery");
    assert!(actual.status.success(), "{}", String::from_utf8_lossy(&actual.stderr));
    assert_eq!(String::from_utf8(actual.stdout).unwrap().trim(), "owner/repo-0 owner/repo-1 owner/repo-2 owner/repo-3 owner/shared");
    let live = justfile.split_once("\ncheck-review-gate:\n").expect("live gate recipe").1.split("\n\n").next().unwrap();
    assert!(live.contains("repos=$({{ just_executable() }} review-gate-repos)"));
    assert!(read("../workflows/ruleset-check.yml").contains("run: just check-review-gate"));
}

#[test]
fn agentic_job_policy_limits_midstream_workflow_edits_to_the_admitted_fork() {
    if !agentic_job_installed() {
        return;
    }
    let head = "0".repeat(40);
    for repo in repos("midstream.toml") {
        for (file, kind) in [("midstream.toml", "create_pull_request"), ("midstream-fix.toml", "push_to_pull_request_branch")] {
            let clone_url = format!("https://github.com/{repo}");
            let file_path = path_of(file);
            let mut args = vec!["policy", "--allow", &file_path, "--repo", &repo, "--clone-url", &clone_url,
                "--kind", "branch", "--outputs", kind, "--max-outputs", "3", "--base"];
            if kind == "create_pull_request" {
                args.push("main");
            } else {
                args.extend(["dispatch/x", "--pull-request", "1", "--head", &head, "--output-repo", &repo]);
            }
            let policy: Value = serde_json::from_str(&agentic_job_ok(&args)).expect("policy JSON");
            let bound = &policy["safe_outputs"][kind];
            let expected = if repo == "cgwalters-forge/gh-agentic-workflows" { json!([".github"]) } else { Value::Null };
            assert_eq!(bound["unprotected_dot_folders"], expected, "{repo} {file}: no other fork may edit protected dot folders");
            assert_eq!(bound["protect_top_level_dot_folders"], true, "{repo} {file}");
            assert_eq!(bound["protected_files_policy"], "blocked", "{repo} {file}");
            let protected = bound["protected_files"].as_array().expect("protected filenames");
            for path in ["AGENTS.md", "CLAUDE.md", "CODEOWNERS", "package.json", "go.mod"] {
                assert!(protected.contains(&json!(path)), "{repo} {file}: {path} must remain blocked");
            }
            if kind == "create_pull_request" {
                assert_eq!(bound["draft"], true, "{repo} {file}");
            }
            assert_ne!(bound["ready_when_complete"], true, "{repo} {file}");
            check_midstream_paths(&policy, &repo, kind, &head);
        }
    }
}

/// Exercise the existing collector and independent patch checker, not a local
/// approximation of protected-path matching. Only an ordinary source file and
/// the admitted fork's workflow may pass.
fn check_midstream_paths(policy: &Value, repo: &str, kind: &str, head: &str) {
    let dir = temp_path("path-check");
    let out = dir.join("out");
    std::fs::create_dir_all(&out).unwrap();
    let policy_path = dir.join("policy.json");
    let collected = dir.join("collected.json");
    std::fs::write(&policy_path, policy.to_string()).unwrap();
    let item = json!({"type": kind, "title": "Test workflow admission", "body": "Test.",
        "message": "Test workflow admission", "branch": "dispatch/x"});
    std::fs::write(out.join("outputs.jsonl"), item.to_string()).unwrap();
    std::fs::write(out.join("base.json"), json!({"repo": repo, "ref": policy["base"], "commit": head}).to_string()).unwrap();
    agentic_job_ok(&["collect", "--policy", policy_path.to_str().unwrap(), "--outputs", out.to_str().unwrap(), "--collected", collected.to_str().unwrap()]);
    for path in ["src/test.txt", ".github/workflows/test.yml", ".other/test.txt", "AGENTS.md", "CLAUDE.md", "CODEOWNERS", "package.json", "go.mod"] {
        let patch = format!("From {} Mon Sep 17 00:00:00 2001\nX-GH-AW-Base-Commit: {head}\nFrom: Test <test@example.test>\nDate: Thu, 5 Nov 2026 00:00:00 +0000\nSubject: [PATCH] Test workflow admission\n\n---\ndiff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n@@ -0,0 +1 @@\n+test\n", "1".repeat(40));
        std::fs::write(out.join("aw-dispatch-x.patch"), patch).unwrap();
        let result = agentic_job(&["check", "--policy", policy_path.to_str().unwrap(), "--outputs", out.to_str().unwrap(), "--collected", collected.to_str().unwrap()]);
        let accepted = path == "src/test.txt" || (repo == "cgwalters-forge/gh-agentic-workflows" && path == ".github/workflows/test.yml");
        assert_eq!(result.status.success(), accepted, "{repo} {kind} {path}: {}\n{}", String::from_utf8_lossy(&result.stderr), String::from_utf8_lossy(&result.stdout));
    }
    std::fs::remove_dir_all(dir).unwrap();
}

// Without `ready_when_complete` apply opens every pull request as a draft,
// and the poll stops on each as "a draft with no checkpoint" (#646). The
// other fields of each entry stay as they were.
#[test]
fn dispatch_and_fix_open_complete_work_ready() {
    assert!(has_line(&outputs("dispatch.toml"), "create_pull_request = { max = 1, ready_when_complete = true }"));
    assert!(has_line(
        &outputs("fix.toml"),
        r#"push_to_pull_request_branch = { max = 1, branches = ["dispatch/**", "bot/**", "release-train/**"], replacement_max_commits = 5, own_author = "cgwalters-bot", ready_when_complete = true }"#
    ));
}

// agentic-job#3164: both fix bounds admit a fix of the bot's own pull request
// in a repository they do not list, and only the bot's, the account apply
// pushes as. Read as TOML, so a misspelt key or another login fails here.
#[test]
fn fix_bounds_admit_the_bots_own_pull_requests_anywhere() {
    let bot = json_file("../poll/agent-board.json")["bot"].as_str().expect("agent-board.json's bot").to_owned();
    assert_eq!(bot, "cgwalters-bot");
    for file in ["fix.toml", "midstream-fix.toml"] {
        let bounds: toml::Table = toml::from_str(&read(file)).unwrap_or_else(|e| panic!("{file}: {e}"));
        let push = &bounds["github"]["outputs"]["push_to_pull_request_branch"];
        assert_eq!(push["own_author"].as_str(), Some(bot.as_str()), "{file}");
    }
}

// The policy job's own reading of `own_author`: an unlisted repository's
// pull request is admitted for a push only when the bot opened it.
#[test]
fn agentic_job_policy_admits_an_unlisted_repository_only_for_the_bots_pull_request() {
    if !agentic_job_installed() {
        return;
    }
    let head = "0".repeat(40);
    let repo = "ostreedev/ostree";
    for file in ["fix.toml", "midstream-fix.toml"] {
        assert!(!repos(file).iter().any(|r| r == repo), "{file} lists {repo}");
        let policy = |author: &str| {
            let clone_url = format!("https://github.com/{repo}");
            let path = path_of(file);
            let mut args = vec![
                "policy", "--allow", &path, "--repo", repo, "--clone-url", &clone_url,
                "--kind", "branch", "--outputs", "push_to_pull_request_branch,noop", "--max-outputs", "3",
                "--base", "bot/boot-finalize-2402", "--pull-request", "3690", "--head", &head, "--output-repo", repo,
            ];
            if !author.is_empty() {
                args.extend(["--pull-author", author]);
            }
            agentic_job(&args)
        };
        let admitted = policy("cgwalters-bot");
        assert!(admitted.status.success(), "{file}: {}", String::from_utf8_lossy(&admitted.stderr));
        let policy_json: Value = serde_json::from_slice(&admitted.stdout).expect("policy JSON");
        assert_eq!(policy_json["safe_outputs"]["push_to_pull_request_branch"]["author"], "cgwalters-bot", "{file}");
        for author in ["someone", "cgwalters", ""] {
            assert!(!policy(author).status.success(), "{file}: {author:?}");
        }
    }
}

// D17 (docs/operator-notes.md, 2026-10-17): bootc-dev is open to
// comment-only kinds and to fix, and to nothing else; comment.toml is
// dispatch.toml's targets with no pull request.
#[test]
fn only_triage_research_and_fix_may_target_bootc_dev() {
    let notes = read("../../docs/operator-notes.md");
    assert!(notes.lines().any(|l| l.strip_prefix("D17 (which bootc-dev runs ").is_some_and(|rest| in_order(
        rest,
        &["**B**. ", "Fix rounds run on the bot's own bootc-dev pull requests", "Triage and research answers may also be posted"]
    ))));
    let mut expected = [repos("dispatch.toml"), repos("midstream.toml")].concat();
    expected.push("bootc-dev/*".to_owned());
    assert_eq!(sorted(repos("comment.toml")), sorted(expected));
    let fix_bootc: Vec<String> = repos("fix.toml").into_iter().filter(|r| r.starts_with("bootc-dev")).collect();
    assert_eq!(fix_bootc, ["bootc-dev/*"]);
    assert!(!repos("dispatch.toml").iter().any(|r| r.starts_with("bootc-dev")));
    let comment_outputs = outputs("comment.toml");
    let keys: Vec<&str> = output_entries(&comment_outputs).into_iter().map(|(k, _)| k).collect();
    assert_eq!(keys, ["add_comment", "noop", "missing_tool", "missing_data"]);
    assert!(!has_line_starting(&read("comment.toml"), "[unprotected_files]"));
    for name in ["dispatch.toml", "fix.toml"] {
        let unprotected = sections(&read(name), "[unprotected_files]");
        let unprotected = unprotected.get(1).unwrap_or_else(|| panic!("{name} has no [unprotected_files]"));
        assert!(!unprotected.contains("bootc-dev"), "{name}");
    }
}

// Midstream forks (the `bot-midstream` topic) take dispatch.toml's and
// fix.toml's bounds without `ready_when_complete`, so their pull requests
// stay drafts (#336); dispatch.yml picks them
// by kind and by the midstream lists.
#[test]
fn the_midstream_bounds_are_the_others_without_ready_when_complete_and_dispatch_picks_them() {
    let uncommented = |text: &str| drop_lines(text, |l| l.starts_with('#'));
    let head = |name: &str| drop_lines(before_table(&read(name)), |l| l.starts_with('#') || l.starts_with("repos = "));
    let entries = |name: &str| -> String {
        drop_lines(&outputs(name), |l| l.starts_with('#') || l == "\n")
            .split_inclusive('\n')
            .map(|l| {
                let (line, end) = l.split_at(l.trim_end_matches('\n').len());
                match line.strip_suffix(", ready_when_complete = true }") {
                    Some(kept) => format!("{kept} }}{end}"),
                    None => l.to_owned(),
                }
            })
            .collect()
    };
    assert_eq!(repos("midstream.toml"), ["cgwalters-forge/composefs-rs", "cgwalters-forge/bootc", "cgwalters-forge/bcvk", "cgwalters-forge/rpm-ostree", "cgwalters-forge/gh-agentic-workflows"]);
    for (midstream, base) in [("midstream.toml", "dispatch.toml"), ("midstream-fix.toml", "fix.toml")] {
        let text = uncommented(&read(midstream));
        assert!(!text.contains("ready_when_complete"), "{midstream}");
        assert_eq!(
            (head(midstream), entries(midstream), repos(midstream)),
            (head(base), entries(base), repos("midstream.toml")),
            "{midstream}"
        );
        // Disjoint, or dispatch.yml's choice would decide which bounds hold.
        for repo in repos(midstream) {
            assert!(!read(base).contains(&format!("\"{repo}\"")), "{repo} in {base}");
        }
    }
    let dispatch = dispatch();
    assert_eq!(
        indented(&dispatch, 6, &["allow: ", "fix-allow: "]),
        [
            "allow: ${{ steps.bounds.outputs.allow }}",
            "fix-allow: ${{ steps.bounds.outputs.fix-allow }}",
            "allow: ${{ needs.profile.outputs.allow }}",
            "fix-allow: ${{ needs.profile.outputs.fix-allow }}",
        ]
        .map(|line| format!("      {line}"))
    );
    let step = step_script("Resolve the bounds");
    // bootc-dev/bootc is upstream, no midstream; neither is a name that only contains one.
    for (repos, allow, fix) in [
        (&["cgwalters-forge/composefs-rs", "cgwalters-forge/bootc", "cgwalters-forge/BootC", "cgwalters-forge/bcvk", "cgwalters-forge/rpm-ostree", "cgwalters-forge/gh-agentic-workflows"][..], "midstream.toml", "midstream-fix.toml"),
        (&["cgwalters-forge/tracker", "bootc-dev/bootc", "cgwalters-forge/bootc-x", "cgwalters-forge", "bootc-dev/gh-agentic-workflows", "cgwalters-forge/gh-agentic-workflows-x"][..], "dispatch.toml", "fix.toml"),
    ] {
        for repo in repos {
            for kind in KINDS {
                let allow = match kind {
                    "triage" | "research" => "comment.toml",
                    _ => allow,
                };
                assert_eq!(
                    run_step(&step, &[("KIND", kind), ("REPO", repo)]),
                    Ok(format!("allow=.github/agentic-job/{allow}\nfix-allow=.github/agentic-job/{fix}\n")),
                    "{kind} {repo}"
                );
            }
        }
    }
}

#[test]
fn agentic_job_policy_admits_bootc_dev_only_for_comments_and_fixes() {
    if !agentic_job_installed() {
        return;
    }
    let policy = |file: &str, kind: &str, outputs: &str| {
        agentic_job(&[
            "policy", "--allow", &path_of(file), "--repo", "bootc-dev/bootc", "--clone-url", "https://github.com/bootc-dev/bootc",
            "--kind", kind, "--outputs", outputs, "--max-outputs", "3", "--base", "main",
        ])
        .status
        .success()
    };
    assert!(policy("comment.toml", "analysis", "add_comment,noop"));
    assert!(!policy("comment.toml", "branch", "create_pull_request,noop"));
    assert!(!policy("dispatch.toml", "analysis", "add_comment,noop"));
    assert!(!policy("dispatch.toml", "branch", "create_pull_request,noop"));
    let head = "0".repeat(40);
    let fix = |repo: &str, branch: &str| {
        let bounds = match repo.starts_with("cgwalters-forge/") {
            true => "midstream-fix.toml",
            false => "fix.toml",
        };
        agentic_job(&[
            "policy", "--allow", &path_of(bounds), "--repo", repo, "--clone-url", &format!("https://github.com/{repo}"),
            "--kind", "branch", "--outputs", "push_to_pull_request_branch,noop", "--max-outputs", "3", "--base", branch,
            "--pull-request", "1", "--head", &head, "--output-repo", repo,
        ])
        .status
        .success()
    };
    // The bot's dispatch branches, and the homegit era's bot/** ones (#710),
    // in bootc-dev and in the midstream forks; no other branch pattern.
    for repo in ["bootc-dev/bootc", "cgwalters-forge/bootc", "cgwalters-forge/composefs-rs", "cgwalters-forge/bcvk"] {
        for branch in ["dispatch/x", "bot/install-output", "bot/a/b"] {
            assert!(fix(repo, branch), "{repo} {branch}");
        }
        for branch in ["main", "feature/x", "BOT/x", "bots/x", "x/bot/y"] {
            assert!(!fix(repo, branch), "{repo} {branch}");
        }
    }
    // Another owner's bootc, composefs-rs or bcvk is no target, even on bot/**.
    // This is the target, not a pull request's head repository: the policy is
    // never told the head, which apply bounds instead (fix.toml's comment on
    // `bot/**`), so no test here can refuse a head owner.
    for repo in ["someone/bootc", "cgwalters-bot/bootc", "containers/composefs-rs", "cgwalters-bot/bcvk", "someone/bcvk"] {
        assert!(!fix(repo, "bot/x"), "{repo}");
    }
}

// The policy job's own reading of the bounds, so a spelling it ignores fails.
#[test]
fn agentic_job_policy_keeps_ready_when_complete_from_both_bounds_and_the_midstream_ones_leave_drafts() {
    if !agentic_job_installed() {
        return;
    }
    let ready = |repo: &str, file: &str, kind: &str, args: &[&str]| {
        let outputs = format!("{kind},noop");
        let clone_url = format!("https://github.com/{repo}");
        let file = path_of(file);
        let mut all = vec![
            "policy", "--allow", &file, "--repo", repo, "--clone-url", &clone_url,
            "--kind", "branch", "--outputs", &outputs, "--max-outputs", "3",
        ];
        all.extend_from_slice(args);
        let policy: Value = serde_json::from_str(&agentic_job_ok(&all)).expect("the policy is JSON");
        let output = &policy["safe_outputs"][kind];
        assert!(output.is_object(), "no safe_outputs.{kind} in {policy}");
        output["ready_when_complete"] == json!(true)
    };
    let head = "0".repeat(40);
    for (repo, allow, fix, expected) in [
        ("cgwalters-forge/tracker", "dispatch.toml", "fix.toml", true),
        ("cgwalters-forge/composefs-rs", "midstream.toml", "midstream-fix.toml", false),
        ("cgwalters-forge/gh-agentic-workflows", "midstream.toml", "midstream-fix.toml", false),
    ] {
        assert_eq!(ready(repo, allow, "create_pull_request", &["--base", "main"]), expected, "{allow}");
        let args = ["--base", "dispatch/x", "--pull-request", "1", "--head", &head, "--output-repo", repo];
        assert_eq!(ready(repo, fix, "push_to_pull_request_branch", &args), expected, "{fix}");
    }
}

#[test]
fn no_repository_the_bot_owns_is_a_dispatch_or_fix_target_unless_it_opts_in() {
    let bot = json_file("../poll/agent-board.json")["bot"].as_str().expect("agent-board.json's bot").to_owned();
    // Bot-owned repositories whose default branch has accept-owner-branches
    // naming them, in lowercase; add one only after checking that file is there.
    let opted_in = BTreeSet::from(["cgwalters-bot/praxis-credential-broker"]);
    for name in ["dispatch.toml", "fix.toml"] {
        for repo in repos(name) {
            if opted_in.contains(repo.to_lowercase().as_str()) {
                continue;
            }
            assert_ne!(
                repo.split('/').next().unwrap_or_default().to_lowercase(),
                bot.to_lowercase(),
                "{repo} in {name} is owned by {bot}: apply cannot push there without its accept-owner-branches; see docs/bring-up.md"
            );
        }
    }
}

#[test]
fn blocked_fixes_can_explain_themselves_without_a_push_or_extra_write_authority() {
    let fix_outputs = outputs("fix.toml");
    let entries = output_entries(&fix_outputs);
    let keys: Vec<&str> = entries.iter().map(|(k, _)| *k).collect();
    assert_eq!(keys, ["push_to_pull_request_branch", "add_comment", "noop", "missing_tool", "missing_data"]);
    let add_comment = entries.iter().find(|(k, _)| *k == "add_comment").map(|(_, v)| *v);
    assert_eq!(add_comment, Some("{ max = 1 }"));
    assert!(has_line(&read("fix.toml"), "max_outputs = 3"));
    let fix = profile("fix");
    for rule in [
        "leave the working tree unchanged",
        "one `add_comment` safe output with a `body`",
        "Do not request `push_to_pull_request_branch` or write a replacement series when there is no change to push",
        "Do not invent a patch",
    ] {
        assert!(fix.contains(rule), "{rule}");
    }
}

#[test]
fn pools_has_what_dispatch_reads_and_a_well_formed_allowance() {
    let pools = pools();
    for (name, pool) in &pools {
        for key in ["agent", "model", "budget"] {
            let value = pool[key].as_str().unwrap_or_else(|| panic!("{name}.{key} is not a string"));
            assert!(!value.is_empty() && !value.contains(char::is_whitespace), "{name}.{key}");
        }
        let budget = pool["budget"].as_str().unwrap_or_default();
        assert!(
            budget.starts_with(|c: char| ('1'..='9').contains(&c)) && budget.chars().all(|c| c.is_ascii_digit()),
            "{name}.budget"
        );
        let Some(allowance) = pool.get("allowance") else {
            continue;
        };
        let allowance = allowance.as_object().unwrap_or_else(|| panic!("{name}.allowance is not an object"));
        let rest: Vec<&String> = allowance.keys().filter(|k| !["amount", "currency", "period"].contains(&k.as_str())).collect();
        assert!(rest.is_empty(), "{name}.allowance: {rest:?}");
        assert!(allowance.get("amount").and_then(Value::as_f64).is_some_and(|a| a.is_finite() && a > 0.0), "{name}.allowance.amount");
        let currency = allowance.get("currency").and_then(Value::as_str).unwrap_or_default();
        assert!(currency.len() == 3 && currency.chars().all(|c| c.is_ascii_uppercase()), "{name}.allowance.currency");
        assert_eq!(allowance.get("period"), Some(&json!("calendar-month")));
    }
    assert_eq!(pools["mistral"]["budget"], "1000");
    assert_eq!(pools["mistral"]["allowance"], json!({ "amount": 300, "currency": "USD", "period": "calendar-month" }));
}

#[test]
fn dispatch_turns_on_the_skills_for_implement_and_fix_only() {
    assert_eq!(
        indented(&dispatch(), 6, &["skills: "]),
        ["      skills: ${{ needs.profile.outputs.skilled == 'true' && (inputs.kind == 'implement' || inputs.kind == 'fix') }}"]
    );
    let implement = profile("implement");
    let full = profile("implement-full");
    assert!(implement.starts_with("Use the implement skill."));
    for rule in ["named caller", "end the PR body with a `Caller settings` section"] {
        assert!(implement.contains(rule), "{rule}");
    }
    for word in ["AGENTS.md", "subagent", "left undone", "file an issue"] {
        assert!(!implement.contains(word), "{word}");
    }
    assert!(!has_word(&full, "skill"));
    assert!(full.starts_with("Implement this issue properly with tests"));
    let rules = implement.trim().split_inclusive(". ").map(|r| r.strip_suffix(' ').unwrap_or(r));
    for rule in rules.skip(1).filter(|r| !r.contains("commit-messages skill")) {
        assert!(full.contains(rule), "{rule}");
    }
    assert!(!profile("fix").contains("implement skill"));
    for kind in ["research", "triage", "review"] {
        assert!(!has_word(&profile(kind), "skill"), "{kind}");
    }
}

/// The `key=value` lines of a step's output.
fn step_outputs(text: &str) -> BTreeMap<String, String> {
    text.lines()
        .filter_map(|l| {
            let (key, value) = l.split_once('=')?;
            (!key.is_empty() && key.chars().all(|c| c.is_ascii_lowercase())).then(|| (key.to_owned(), value.to_owned()))
        })
        .collect()
}

/// The task of a `task<<DELIMITER` heredoc output.
fn heredoc_task(composed: &str) -> Option<&str> {
    let rest = composed.strip_prefix("task<<")?;
    let (delimiter, rest) = rest.split_once('\n')?;
    let hex = delimiter.strip_prefix("task-")?;
    if hex.len() != 32 || !hex.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)) {
        return None;
    }
    rest.strip_suffix(&format!("\n{delimiter}\n"))
}

#[test]
fn dispatch_gives_an_agent_without_skills_the_full_implement_profile() {
    let dispatch = dispatch();
    let index = |s: &str| dispatch.find(s).map_or(-1, |i| i as i64);
    assert!(index("- name: Resolve the pool") < index("- name: Put the profile before the task"));
    let pool_step = step_script("Resolve the pool");
    let compose_step = step_script("Put the profile before the task");
    let run = |pool: &str, kind: &str, agent: &str| -> Option<BTreeMap<String, String>> {
        let mut resolved = step_outputs(&run_step(&pool_step, &[("POOL", pool), ("KIND", kind), ("AGENT", agent)]).ok()?);
        let mut env = vec![("KIND", kind), ("TASK", "the task")];
        if let Some(skilled) = resolved.get("skilled") {
            env.push(("SKILLED", skilled.as_str()));
        }
        let composed = run_step(&compose_step, &env).ok()?;
        let task = heredoc_task(&composed).filter(|t| !t.is_empty());
        let task = task.unwrap_or_else(|| panic!("{composed}")).to_owned();
        resolved.insert("task".to_owned(), task);
        Some(resolved)
    };
    let expected = |kind: &str, skilled: bool| {
        let full = format!("{kind}-full");
        let name = match !skilled && here().join(format!("profiles/{full}.md")).exists() {
            true => full.as_str(),
            false => kind,
        };
        format!("{}\nthe task", profile(name))
    };
    let unpooled = |skilled: &str, task: String| {
        BTreeMap::from([("skilled", skilled), ("agent", ""), ("model", ""), ("budget", ""), ("task", task.as_str())].map(|(k, v)| (k.to_owned(), v.to_owned())))
    };
    let pools = pools();
    for (name, pool) in &pools {
        let agent = pool["agent"].as_str().expect("a pool's agent");
        let skilled = SKILLED_AGENTS.contains(&agent);
        for kind in KINDS {
            let r = run(name, kind, if skilled { "vibe" } else { "claude" });
            let r = r.unwrap_or_else(|| panic!("{kind} on {name}"));
            assert_eq!(r.get("agent").map(String::as_str), Some(agent));
            assert_eq!(r.get("skilled"), Some(&skilled.to_string()));
            assert_eq!(r.get("task"), Some(&expected(kind, skilled)));
        }
    }
    let agents: Vec<&str> = pools.values().map(|p| p["agent"].as_str().unwrap_or_default()).collect();
    assert!(agents.iter().any(|a| !SKILLED_AGENTS.contains(a)));
    assert!(agents.iter().any(|a| SKILLED_AGENTS.contains(a)));
    for agent in ["claude", "opencode", "fake"] {
        assert_eq!(run("", "implement", agent), Some(unpooled("true", expected("implement", true))));
    }
    assert_eq!(run("", "implement", "vibe"), Some(unpooled("false", expected("implement", false))));
    assert_eq!(run("", "fix", "vibe").expect("fix on vibe")["task"], expected("fix", false));
    assert_ne!(expected("implement", false), expected("implement", true));
    assert_eq!(expected("fix", false), expected("fix", true));
    assert_eq!(run("nonesuch", "fix", "opencode"), None);
    assert_eq!(run("", "implement-full", "vibe"), None);
}

/// Whether `uses` is `OWNER/PATH@REV` with `rev` accepting its REV.
fn is_ref(uses: &str, rev: impl Fn(&str) -> bool) -> bool {
    let name = |s: &str, extra: &[char]| !s.is_empty() && s.chars().all(|c| is_word(c) || c == '.' || c == '-' || extra.contains(&c));
    let Some((path, at)) = uses.split_once('@') else {
        return false;
    };
    let Some((owner, path)) = path.split_once('/') else {
        return false;
    };
    name(owner, &[]) && name(path, &['/']) && rev(at)
}

fn is_commit(rev: &str) -> bool {
    rev.len() == 40 && rev.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

#[test]
fn workflows_follow_our_own_repositories_at_main_review_excepted_and_pin_the_rest() {
    let dispatch_repo = json_file("../poll/agent-board.json")["dispatchRepo"].as_str().expect("dispatchRepo").to_owned();
    let owner = format!("{}/", dispatch_repo.split('/').next().unwrap_or_default());
    let dir = here().join("../workflows");
    let mut seen = 0;
    for entry in std::fs::read_dir(&dir).expect("listing the workflows") {
        let path = entry.expect("a workflow").path();
        let file = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
        if !file.ends_with(".yml") {
            continue;
        }
        let text = std::fs::read_to_string(&path).expect("reading a workflow");
        for line in text.lines() {
            let line = line.trim_start();
            let line = line.strip_prefix("- ").unwrap_or(line);
            let Some(uses) = line.strip_prefix("uses:") else {
                continue;
            };
            // Require the value on this line so a multiline scalar cannot
            // silently bypass the pin check.
            let uses = uses.split_whitespace().next().unwrap_or_else(|| {
                panic!("{file}: uses: must have its value on the same line")
            });
            seen += 1;
            // Except review.yml: its verdict is the only gate on .github/ here,
            // so the wrapper it calls moves only by a reviewed change to the pin.
            let ordinary_review = file == "dispatch.yml"
                && uses == "cgwalters-forge/actions/.github/workflows/cgwalters-agentic-job.yml@ba6c56925e63551fd4373fbeb23456a2f4a316da";
            // Retro composes the harness directly: policy/check/apply and the
            // actions must run at one immutable source revision. Its workflow
            // test checks that all six pins agree.
            let retro_piece = file == "retro.yml"
                && uses.starts_with("cgwalters-forge/agentic-job/");
            let ok = match uses.starts_with(&owner) && file != "review.yml" && !ordinary_review && !retro_piece {
                true => is_ref(uses, |rev| rev == "main"),
                false => is_ref(uses, is_commit),
            };
            assert!(ok, "{file}: {uses}");
        }
    }
    assert!(seen > 0);
}

// The release train moves this pin: the commit wherever it stands, and the
// version after `agentic-job ` plain or escaped as in a pattern
// (.github/release-train/config.json), so it stays in this form.
#[test]
fn review_wrapper_uses_the_release_pin() {
    let pin = r"cgwalters-review\.yml@02d0342d682cf1c265668d7823009ae1936c4061 # main, agentic-job v0\.6\.11 \(actions#67\)";
    let pin = pin.replace('\\', "");
    let workflow = read("../workflows/review.yml");
    let pinned = workflow.lines().any(|line| {
        let trimmed = line.trim_start();
        trimmed.len() < line.len()
            && trimmed
                .strip_prefix("uses: ")
                .and_then(|uses| uses.strip_suffix(&pin))
                .and_then(|uses| uses.strip_suffix('/'))
                .is_some_and(|owner| !owner.is_empty() && !owner.contains(char::is_whitespace))
    });
    assert!(pinned, "review.yml does not pin {pin}");
}

#[test]
fn the_pass_starts_work_only_where_dispatch_and_fix_runs_may_act_on_known_pools() {
    let pass = json_file("../pass.json");
    let either = |names: &[&str]| -> Vec<String> { names.iter().flat_map(|n| repos(n)).collect() };
    let names = |v: &Value, what: &str| -> Vec<String> {
        v.as_array()
            .unwrap_or_else(|| panic!("{what} is not an array"))
            .iter()
            .map(|s| s.as_str().unwrap_or_else(|| panic!("{what} has a non-string")).to_owned())
            .collect()
    };
    let scheduled = either(&["dispatch.toml", "midstream.toml"]);
    for repo in names(&pass["workRepositories"], "workRepositories") {
        assert!(scheduled.contains(&repo), "{repo} is scheduled but not in dispatch.toml or midstream.toml");
    }
    // An `owner/*` bound covers each of that owner's repositories.
    let followed = either(&["fix.toml", "midstream-fix.toml"]);
    for repo in names(&pass["follow"], "follow") {
        let covered = followed
            .iter()
            .any(|r| *r == repo || r.strip_suffix("/*").is_some_and(|owner| repo.starts_with(&format!("{owner}/"))));
        assert!(covered, "{repo} is followed but not in fix.toml or midstream-fix.toml");
    }
    let mut used: Vec<String> = pass["pools"].as_object().expect("pass.json's pools").keys().cloned().collect();
    for key in ["planPools", "triagePools"] {
        used.extend(names(&pass[key], key));
    }
    used.extend(names(&pass["pr"]["fixPools"], "pr.fixPools"));
    for key in ["toilFixPool", "conflictFixPool"] {
        // Optional: absent, null, false or empty is none.
        match &pass["pr"][key] {
            Value::Null | Value::Bool(false) => {}
            Value::String(pool) if pool.is_empty() => {}
            Value::String(pool) => used.push(pool.clone()),
            other => panic!("pr.{key} is not a pool name: {other}"),
        }
    }
    let pools = pools();
    for pool in used {
        assert!(pools.contains_key(&pool), "{pool}");
    }
    assert_eq!(pass["dispatchWorkflow"], "dispatch.yml");
    assert_eq!(pass["pr"]["reviewWorkflow"], "review.yml");
}

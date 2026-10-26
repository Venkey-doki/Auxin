//! Service detection: walks a workspace folder and turns each child repo into a
//! `DetectedService` with suggested start commands.

use serde::Serialize;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandSuggestion {
    pub label: String,
    pub command: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedService {
    /// Absolute path; doubles as the stable id.
    pub id: String,
    pub name: String,
    pub path: String,
    pub kind: String,
    pub framework: Option<String>,
    pub suggestions: Vec<CommandSuggestion>,
    pub default_command: Option<String>,
    /// Absolute path of a virtualenv found inside the service folder.
    pub venv: Option<String>,
    pub port_hint: Option<u16>,
    /// Already depends on an OpenTelemetry SDK, so it can export spans to Auxin unchanged.
    pub otel: bool,
}

const SKIP_DIRS: &[&str] = &[
    "node_modules", "dist", "build", "target", "coverage", "__pycache__", "venv", ".venv", "env",
    "vendor", "out", "tmp", "logs", "results", "data",
];

/// Containers that commonly hold several services in a monorepo.
const NESTED_PARENTS: &[&str] = &["apps", "services", "packages", "backend", "servers"];

pub fn scan(root: &Path) -> Vec<DetectedService> {
    let mut found = Vec::new();
    if let Some(svc) = detect(root) {
        // The root itself is one service (single-repo workspace). Still look for
        // monorepo children below it.
        found.push(svc);
        for parent in NESTED_PARENTS {
            scan_children(&root.join(parent), &mut found, 0);
        }
    } else {
        scan_children(root, &mut found, 1);
    }
    found.sort_by_key(|a| a.name.to_lowercase());
    found.dedup_by(|a, b| a.id == b.id);
    found
}

fn scan_children(dir: &Path, found: &mut Vec<DetectedService>, depth_left: u8) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir() && !is_skipped(p))
        .collect();
    dirs.sort();
    for d in dirs {
        if is_venv(&d) {
            continue;
        }
        if let Some(svc) = detect(&d) {
            found.push(svc);
            for parent in NESTED_PARENTS {
                scan_children(&d.join(parent), found, 0);
            }
        } else if depth_left > 0 {
            scan_children(&d, found, depth_left - 1);
        }
    }
}

fn is_skipped(p: &Path) -> bool {
    let name = file_name(p);
    name.starts_with('.') || SKIP_DIRS.contains(&name.as_str())
}

fn is_venv(p: &Path) -> bool {
    p.join("pyvenv.cfg").is_file()
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

fn read(p: &Path) -> Option<String> {
    fs::read_to_string(p).ok()
}

struct Builder {
    kind: Option<&'static str>,
    framework: Option<String>,
    suggestions: Vec<CommandSuggestion>,
    seen: BTreeSet<String>,
}

impl Builder {
    fn push(&mut self, label: impl Into<String>, command: impl Into<String>, source: &str) {
        let command = command.into();
        if self.seen.insert(command.clone()) {
            self.suggestions.push(CommandSuggestion { label: label.into(), command, source: source.into() });
        }
    }
    fn kind(&mut self, k: &'static str) {
        if self.kind.is_none() {
            self.kind = Some(k);
        }
    }
}

fn detect(dir: &Path) -> Option<DetectedService> {
    let mut b = Builder { kind: None, framework: None, suggestions: Vec::new(), seen: BTreeSet::new() };
    let venv = find_venv(dir);

    // Order matters: the first suggestion becomes the default command, and an
    // explicit Procfile / package script / Makefile target beats a guess.
    detect_procfile(dir, &mut b);
    detect_node(dir, &mut b);
    let has_make = detect_makefile(dir, &mut b);
    let python_port = detect_python(dir, &mut b);
    detect_simple(dir, &mut b);
    if dir.join("docker-compose.yml").is_file() || dir.join("compose.yaml").is_file() || dir.join("docker-compose.yaml").is_file() {
        b.kind("docker");
        b.push("docker compose up", "docker compose up", "docker-compose");
    }
    if has_make {
        b.kind("make");
    }

    let kind = b.kind?;
    let default_command = b.suggestions.first().map(|s| s.command.clone());
    let path = dir.to_string_lossy().into_owned();
    Some(DetectedService {
        id: path.clone(),
        name: file_name(dir),
        path,
        kind: kind.into(),
        framework: b.framework,
        suggestions: b.suggestions,
        default_command,
        venv: venv.map(|v| v.to_string_lossy().into_owned()),
        port_hint: port_from_env_file(dir).or(python_port),
        otel: uses_otel(dir),
    })
}

/// Looks for an OpenTelemetry dependency in the folder's own manifests (not subfolders).
fn uses_otel(dir: &Path) -> bool {
    let node = read(&dir.join("package.json")).and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()).is_some_and(|pkg| {
        ["dependencies", "devDependencies"].iter().filter_map(|k| pkg.get(k)?.as_object()).any(|d| d.keys().any(|n| n.starts_with("@opentelemetry/")))
    });
    node || fs::read_dir(dir).into_iter().flatten().flatten().any(|e| {
        let name = e.file_name().to_string_lossy().into_owned();
        let needle = match name.as_str() {
            "pyproject.toml" | "Pipfile" | "setup.py" => "opentelemetry",
            n if n.starts_with("requirements") && n.ends_with(".txt") => "opentelemetry",
            "go.mod" => "go.opentelemetry.io",
            "pom.xml" | "build.gradle" | "build.gradle.kts" => "io.opentelemetry",
            n if n.ends_with(".csproj") => "opentelemetry",
            _ => return false,
        };
        read(&e.path()).is_some_and(|t| t.to_lowercase().contains(needle))
    })
}

fn detect_procfile(dir: &Path, b: &mut Builder) {
    let Some(text) = read(&dir.join("Procfile")) else { return };
    for line in text.lines() {
        if let Some((name, cmd)) = line.split_once(':') {
            let (name, cmd) = (name.trim(), cmd.trim());
            if !name.is_empty() && !cmd.is_empty() && !name.starts_with('#') {
                b.kind("procfile");
                b.push(format!("Procfile: {name}"), cmd, "Procfile");
            }
        }
    }
}

fn detect_node(dir: &Path, b: &mut Builder) {
    let Some(text) = read(&dir.join("package.json")) else { return };
    let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&text) else { return };
    b.kind("node");

    let pm = if dir.join("pnpm-lock.yaml").is_file() {
        "pnpm"
    } else if dir.join("yarn.lock").is_file() {
        "yarn"
    } else if dir.join("bun.lockb").is_file() || dir.join("bun.lock").is_file() {
        "bun"
    } else {
        "npm"
    };
    let run = |script: &str| match pm {
        "npm" if script == "start" => "npm start".to_string(),
        "npm" => format!("npm run {script}"),
        other => format!("{other} {script}"),
    };

    let deps = |key: &str| pkg.get(key).and_then(|d| d.as_object()).cloned().unwrap_or_default();
    let all: Vec<String> = deps("dependencies").keys().chain(deps("devDependencies").keys()).cloned().collect();
    let has = |n: &str| all.iter().any(|d| d == n);
    b.framework = [
        ("next", "Next.js"), ("@nestjs/core", "NestJS"), ("nuxt", "Nuxt"), ("@remix-run/node", "Remix"),
        ("@sveltejs/kit", "SvelteKit"), ("astro", "Astro"), ("vite", "Vite"), ("fastify", "Fastify"),
        ("express", "Express"), ("koa", "Koa"), ("hono", "Hono"), ("@angular/core", "Angular"),
    ]
    .iter()
    .find(|(dep, _)| has(dep))
    .map(|(_, label)| label.to_string());

    let Some(scripts) = pkg.get("scripts").and_then(|s| s.as_object()) else { return };
    // Long-running scripts first, in the order a developer usually wants them.
    const PREFERRED: &[&str] = &["dev", "start:dev", "develop", "serve", "start:local", "local", "start", "watch"];
    for name in PREFERRED {
        if scripts.contains_key(*name) {
            b.push(format!("{name} script"), run(name), "package.json");
        }
    }
    const NOT_SERVERS: &[&str] = &["build", "clean", "test", "lint", "format", "prepare", "postinstall", "preinstall", "typecheck"];
    for name in scripts.keys() {
        let base = name.split(':').next().unwrap_or(name);
        if !NOT_SERVERS.contains(&base) && !name.starts_with("pre") && !name.starts_with("post") {
            b.push(format!("{name} script"), run(name), "package.json");
        }
    }
}

/// Returns a port found in a self-launching entry point (`uvicorn.run(..., port=8000)`).
fn detect_python(dir: &Path, b: &mut Builder) -> Option<u16> {
    let markers = ["requirements.txt", "pyproject.toml", "setup.py", "Pipfile", "manage.py"];
    let entries = ["main_local.py", "app.py", "main.py", "server.py", "run.py", "wsgi.py", "serve.py"];
    let has_marker = markers.iter().any(|m| dir.join(m).is_file());
    let has_entry = entries.iter().any(|e| dir.join(e).is_file());
    if !has_marker && !has_entry {
        return None;
    }
    b.kind("python");

    let reqs = read(&dir.join("requirements.txt")).unwrap_or_default().to_lowercase()
        + &read(&dir.join("pyproject.toml")).unwrap_or_default().to_lowercase();
    let framework = ["django", "fastapi", "flask", "streamlit"].into_iter().find(|f| reqs.contains(f));
    b.framework = framework.map(|f| match f {
        "django" => "Django".to_string(),
        "fastapi" => "FastAPI".to_string(),
        "flask" => "Flask".to_string(),
        _ => "Streamlit".to_string(),
    });

    if dir.join("manage.py").is_file() {
        b.push("Django dev server", "python manage.py runserver", "manage.py");
    }
    // Entry points that start their own server (`if __name__ == "__main__": uvicorn.run(...)`)
    // encode the developer's chosen host/port, so they win over a generic uvicorn call.
    let mut port = None;
    let mut plain_entries = Vec::new();
    for entry in entries {
        let Some(src) = read(&dir.join(entry)) else { continue };
        let main_block = src.rfind("if __name__").map(|i| &src[i..]).unwrap_or("");
        if !main_block.is_empty() && [".run(", "serve(", "serve_forever"].iter().any(|c| main_block.contains(c)) {
            b.push(entry.to_string(), format!("python {entry}"), entry);
            port = port.or_else(|| find_port_kwarg(main_block));
        } else {
            plain_entries.push(entry);
        }
    }
    // ASGI apps: look for `app = FastAPI(` in the usual module locations.
    for module in ["main.py", "app.py", "app/main.py", "src/main.py", "api/main.py"] {
        if let Some(src) = read(&dir.join(module)) {
            if src.contains("FastAPI(") {
                let dotted = module.trim_end_matches(".py").replace('/', ".");
                b.push(format!("uvicorn {dotted}"), format!("uvicorn {dotted}:app --reload"), module);
            }
            if module == "app.py" && src.contains("streamlit") {
                b.push("streamlit app", "streamlit run app.py", module);
            }
        }
    }
    for entry in plain_entries {
        b.push(entry.to_string(), format!("python {entry}"), entry);
    }
    if dir.join("app/__main__.py").is_file() {
        b.push("python -m app", "python -m app", "app/__main__.py");
    }
    port
}

fn find_port_kwarg(src: &str) -> Option<u16> {
    let i = src.find("port=")?;
    let digits: String = src[i + 5..].trim_start().chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

fn detect_simple(dir: &Path, b: &mut Builder) {
    if dir.join("go.mod").is_file() {
        b.kind("go");
        b.push("go run", "go run .", "go.mod");
    }
    if dir.join("Cargo.toml").is_file() {
        b.kind("rust");
        b.push("cargo run", "cargo run", "Cargo.toml");
    }
    if dir.join("pom.xml").is_file() {
        b.kind("java");
        let mvn = if dir.join("mvnw").is_file() { "./mvnw" } else { "mvn" };
        b.push("Spring Boot (Maven)", format!("{mvn} spring-boot:run"), "pom.xml");
    }
    if dir.join("build.gradle").is_file() || dir.join("build.gradle.kts").is_file() {
        b.kind("java");
        let gradle = if dir.join("gradlew").is_file() { "./gradlew" } else { "gradle" };
        b.push("Gradle bootRun", format!("{gradle} bootRun"), "build.gradle");
    }
    if dir.join("Gemfile").is_file() && dir.join("config.ru").is_file() {
        b.kind("ruby");
        b.push("rails server", "bin/rails server", "Gemfile");
    }
}

/// Returns whether the Makefile has a runnable target.
fn detect_makefile(dir: &Path, b: &mut Builder) -> bool {
    let Some(text) = read(&dir.join("Makefile")) else { return false };
    let targets: Vec<&str> = text
        .lines()
        .filter(|l| !l.starts_with('\t') && !l.starts_with('.') && !l.starts_with('#'))
        .filter_map(|l| l.split_once(':').map(|(t, rest)| (t.trim(), rest)))
        .filter(|(t, rest)| !rest.starts_with('=') && !t.is_empty() && t.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_'))
        .map(|(t, _)| t)
        .collect();
    let runnable = ["dev", "run", "start", "serve", "up", "local"];
    let mut any = false;
    for t in runnable {
        if targets.contains(&t) {
            b.push(format!("make {t}"), format!("make {t}"), "Makefile");
            any = true;
        }
    }
    any
}

fn find_venv(dir: &Path) -> Option<PathBuf> {
    for name in [".venv", "venv", "env", ".env"] {
        let p = dir.join(name);
        if is_venv(&p) {
            return Some(p);
        }
    }
    // Custom-named virtualenvs (e.g. `py-env`) are recognised by pyvenv.cfg.
    fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).find(|p| p.is_dir() && is_venv(p))
}

fn port_from_env_file(dir: &Path) -> Option<u16> {
    for f in [".env.local", ".env.development", ".env"] {
        let Some(text) = read(&dir.join(f)) else { continue };
        for line in text.lines() {
            let line = line.trim().trim_start_matches("export ");
            if let Some(v) = line.strip_prefix("PORT=")
                && let Ok(port) = v.trim().trim_matches('"').trim_matches('\'').parse() {
                    return Some(port);
                }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `AUXIN_SCAN_ROOT=~/code cargo test scan_prints -- --nocapture --ignored`
    #[test]
    #[ignore]
    fn scan_prints() {
        let root = std::env::var("AUXIN_SCAN_ROOT").expect("set AUXIN_SCAN_ROOT");
        for s in scan(Path::new(&root)) {
            println!("{:<55} {:<8} {:<10} {:?} venv={:?}", s.name, s.kind, s.framework.unwrap_or_default(), s.default_command, s.venv.map(|v| file_name(Path::new(&v))));
        }
    }

    #[test]
    fn detects_opentelemetry() {
        let dir = tempfile::tempdir().unwrap();
        let files = [
            ("web/package.json", r#"{"scripts":{"dev":"node ."},"dependencies":{"@opentelemetry/sdk-node":"^0.57.0"}}"#),
            ("plain/package.json", r#"{"scripts":{"dev":"node ."},"dependencies":{"express":"^4"},"description":"no @opentelemetry/ here"}"#),
            ("api/requirements-dev.txt", "OpenTelemetry-Distro==0.48b0\n"),
            ("api/main.py", "print(1)\n"),
            ("pay/go.mod", "module pay\nrequire go.opentelemetry.io/otel v1.32.0\n"),
            ("billing/pom.xml", "<artifactId>opentelemetry-api</artifactId><groupId>io.opentelemetry</groupId>"),
            ("orders/Orders.csproj", "<PackageReference Include=\"OpenTelemetry.Extensions.Hosting\" />"),
            ("orders/Procfile", "web: dotnet run\n"),
            // Only the service's top level counts.
            ("nested/go.mod", "module nested\n"),
            ("nested/tools/go.mod", "require go.opentelemetry.io/otel v1.32.0\n"),
        ];
        for (path, text) in files {
            let p = dir.path().join(path);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, text).unwrap();
        }
        let otel: Vec<(String, bool)> = scan(dir.path()).into_iter().map(|s| (s.name, s.otel)).collect();
        let expect = [("api", true), ("billing", true), ("nested", false), ("orders", true), ("pay", true), ("plain", false), ("web", true)];
        assert_eq!(otel, expect.map(|(n, o)| (n.to_string(), o)));
    }
}

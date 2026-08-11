//! Parse shell command strings with the vendored brush parser and emit a
//! compact JSON node list.

use brush_parser::{Parser, ParserOptions, SourceInfo, ast::*};
use serde_json::{Value, json};

/// Parse `command` with the same `brush-parser` configuration the vendored
/// runtime uses.
pub fn parse_script(command: &str) -> Result<Program, brush_parser::ParseError> {
	let options = ParserOptions::default();
	let source_info = SourceInfo::default();
	let reader = std::io::Cursor::new(command.as_bytes());
	let mut parser = Parser::new(reader, &options, &source_info);
	parser.parse_program()
}

/// Parse `command` and serialize it as a compact JSON node list:
/// `[{kind, text, words?, redirects?, children}, ...]`.
pub fn parse_script_json(command: &str) -> Result<String, brush_parser::ParseError> {
	let program = parse_script(command)?;
	let nodes: Vec<Value> = program
		.complete_commands
		.iter()
		.flat_map(|cc| cc.0.iter())
		.map(item_node)
		.collect();
	Ok(serde_json::to_string(&nodes).expect("JSON serialization cannot fail"))
}

/// One top-level item (`CompoundListItem`): an and/or list plus its `;`/`&`
/// separator. Items without `&&`/`||` and with a plain sequence separator
/// flatten to the bare pipeline/command node.
fn item_node(item: &CompoundListItem) -> Value {
	let separator = match item.1 {
		SeparatorOperator::Async => "&",
		SeparatorOperator::Sequence => ";",
	};
	let and_or = &item.0;
	let mut children = vec![pipeline_node(&and_or.first)];
	for extra in &and_or.additional {
		let (kind, pipe) = match extra {
			AndOr::And(p) => ("and", p),
			AndOr::Or(p) => ("or", p),
		};
		children.push(json!({
			"kind": kind,
			"text": pipe.to_string(),
			"children": vec![pipeline_node(pipe)],
		}));
	}
	if and_or.additional.is_empty() && matches!(item.1, SeparatorOperator::Sequence) {
		return pipeline_node(&and_or.first);
	}
	json!({
		"kind": "sequence",
		"text": item.to_string(),
		"operator": separator,
		"children": children,
	})
}

fn pipeline_node(pipeline: &Pipeline) -> Value {
	if pipeline.seq.len() == 1 {
		return command_node(&pipeline.seq[0]);
	}
	json!({
		"kind": "pipeline",
		"text": pipeline.to_string(),
		"operator": "|",
		"children": pipeline.seq.iter().map(command_node).collect::<Vec<_>>(),
	})
}

fn command_node(cmd: &Command) -> Value {
	match cmd {
		Command::Simple(simple) => {
			let mut words: Vec<String> = Vec::new();
			let mut redirects: Vec<String> = Vec::new();
			if let Some(prefix) = &simple.prefix {
				for item in &prefix.0 {
					match item {
						CommandPrefixOrSuffixItem::Word(w) => words.push(w.value.clone()),
						CommandPrefixOrSuffixItem::IoRedirect(r) => redirects.push(r.to_string()),
						_ => {},
					}
				}
			}
			if let Some(w) = &simple.word_or_name {
				words.push(w.value.clone());
			}
			if let Some(suffix) = &simple.suffix {
				for item in &suffix.0 {
					match item {
						CommandPrefixOrSuffixItem::Word(w) => words.push(w.value.clone()),
						CommandPrefixOrSuffixItem::IoRedirect(r) => redirects.push(r.to_string()),
						_ => {},
					}
				}
			}
			json!({
				"kind": "simpleCommand",
				"text": simple.to_string(),
				"words": words,
				"redirects": redirects,
				"children": [],
			})
		},
		Command::Compound(compound, redirects) => {
			let kind = match compound {
				CompoundCommand::IfClause(_) => "ifClause",
				CompoundCommand::WhileClause(_) => "whileClause",
				CompoundCommand::UntilClause(_) => "untilClause",
				CompoundCommand::ForClause(_) => "forClause",
				CompoundCommand::CaseClause(_) => "caseClause",
				CompoundCommand::BraceGroup(_) => "braceGroup",
				CompoundCommand::Subshell(_) => "subshell",
				CompoundCommand::Arithmetic(_) => "arithmetic",
				CompoundCommand::ArithmeticForClause(_) => "arithmeticForClause",
			};
			let mut node = json!({
				"kind": kind,
				"text": compound.to_string(),
				"children": [],
			});
			if let Some(list) = redirects {
				node["redirects"] = json!(list.0.iter().map(|r| r.to_string()).collect::<Vec<_>>());
			}
			node
		},
		Command::Function(_) => {
			json!({ "kind": "functionDefinition", "text": cmd.to_string(), "children": [] })
		},
		Command::ExtendedTest(_) => {
			json!({ "kind": "extendedTest", "text": cmd.to_string(), "children": [] })
		},
	}
}

#[cfg(test)]
mod tests {
	use serde_json::Value;

	fn parse_json(command: &str) -> Result<Value, String> {
		let s = super::parse_script_json(command).map_err(|e| e.to_string())?;
		serde_json::from_str(&s).map_err(|e| e.to_string())
	}

	#[test]
	fn simple_command_nodes() {
		let nodes = parse_json("echo hi").expect("parse ok");
		let first = &nodes[0];
		assert_eq!(first["kind"], "simpleCommand");
		assert_eq!(first["words"][0], "echo");
		assert_eq!(first["words"][1], "hi");
	}

	#[test]
	fn pipeline_stays_one_node_with_children() {
		let nodes = parse_json("ls -la | grep foo").expect("parse ok");
		assert_eq!(nodes[0]["kind"], "pipeline");
		assert_eq!(nodes[0]["children"].as_array().unwrap().len(), 2);
	}

	#[test]
	fn and_or_and_sequence_operators_surface() {
		let nodes = parse_json("a && b; c &").expect("parse ok");
		assert_eq!(nodes.as_array().unwrap().len(), 2);
		// `&&` surfaces as an `and` child of the sequence item.
		assert_eq!(nodes[0]["children"][1]["kind"], "and");
		// `;` surfaces as the sequence operator of the first item.
		assert_eq!(nodes[0]["operator"], ";");
		// brush models `&` as an Async separator on the item, so it surfaces
		// as the sequence operator of the second item — distinct from `||`.
		assert_eq!(nodes[1]["operator"], "&");
		let or_nodes = parse_json("x || y").expect("parse ok");
		assert_eq!(or_nodes[0]["children"][1]["kind"], "or");
	}

	#[test]
	fn if_clause_compound_kind() {
		let nodes = parse_json("if true; then echo x; fi").expect("parse ok");
		assert_eq!(nodes[0]["kind"], "ifClause");
	}

	#[test]
	fn syntax_error_is_err() {
		assert!(super::parse_script_json("echo 'unterminated").is_err());
	}

	#[test]
	fn empty_command_yields_empty_list() {
		let nodes = parse_json("").expect("parse ok");
		assert_eq!(nodes.as_array().unwrap().len(), 0);
	}
}

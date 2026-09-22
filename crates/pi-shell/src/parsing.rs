//! Parse shell command strings with the vendored brush parser and emit a
//! compact JSON node list.

use brush_parser::{
	Parser, ParserOptions,
	ast::*,
	word::{self, ParameterExpr, WordPiece},
};
use serde_json::{Value, json};

/// Parse `command` with the same `brush-parser` configuration the vendored
/// runtime uses.
pub fn parse_script(command: &str) -> Result<Program, brush_parser::ParseError> {
	let options = ParserOptions::default();
	let reader = std::io::Cursor::new(command.as_bytes());
	let mut parser = Parser::new(reader, &options);
	parser.parse_program()
}

/// Parse `command` with brush and emit a compact JSON node list.
///
/// Nodes are `{kind, text, words?, redirects?, substitutions?, children}`;
/// `substitutions` holds the `$(…)`/backtick command texts collected from a
/// simple command's words (grammar-level, quote-aware).
pub fn parse_script_json(command: &str) -> Result<String, brush_parser::ParseError> {
	let program = parse_script(command)?;
	let options = ParserOptions::default();
	let nodes: Vec<Value> = program
		.complete_commands
		.iter()
		.flat_map(|cc| cc.0.iter())
		.map(|item| item_node(item, &options))
		.collect();
	Ok(serde_json::to_string(&nodes).expect("JSON serialization cannot fail"))
}

/// One top-level item (`CompoundListItem`): an and/or list plus its `;`/`&`
/// separator. Items without `&&`/`||` and with a plain sequence separator
/// flatten to the bare pipeline/command node.
fn item_node(item: &CompoundListItem, options: &ParserOptions) -> Value {
	let separator = match item.1 {
		SeparatorOperator::Async => "&",
		SeparatorOperator::Sequence => ";",
	};
	let and_or = &item.0;
	let mut children = vec![pipeline_node(&and_or.first, options)];
	for extra in &and_or.additional {
		let (kind, pipe) = match extra {
			AndOr::And(p) => ("and", p),
			AndOr::Or(p) => ("or", p),
		};
		children.push(json!({
			"kind": kind,
			"text": pipe.to_string(),
			"children": vec![pipeline_node(pipe, options)],
		}));
	}
	if and_or.additional.is_empty() && matches!(item.1, SeparatorOperator::Sequence) {
		return pipeline_node(&and_or.first, options);
	}
	json!({
		"kind": "sequence",
		"text": item.to_string(),
		"operator": separator,
		"children": children,
	})
}

fn pipeline_node(pipeline: &Pipeline, options: &ParserOptions) -> Value {
	if pipeline.seq.len() == 1 {
		return command_node(&pipeline.seq[0], options);
	}
	json!({
		"kind": "pipeline",
		"text": pipeline.to_string(),
		"operator": "|",
		"children": pipeline.seq.iter().map(|cmd| command_node(cmd, options)).collect::<Vec<_>>(),
	})
}

fn command_node(cmd: &Command, options: &ParserOptions) -> Value {
	match cmd {
		Command::Simple(simple) => {
			let mut words: Vec<String> = Vec::new();
			let mut redirects: Vec<String> = Vec::new();
			let mut substitutions: Vec<String> = Vec::new();
			let mut substitutions_ok = true;
			let mut push_word = |w: &Word| {
				words.push(w.value.clone());
				if !collect_substitutions(&w.value, options, &mut substitutions) {
					substitutions_ok = false;
				}
			};
			if let Some(prefix) = &simple.prefix {
				for item in &prefix.0 {
					match item {
						CommandPrefixOrSuffixItem::Word(w) => push_word(w),
						CommandPrefixOrSuffixItem::IoRedirect(r) => redirects.push(r.to_string()),
						_ => {},
					}
				}
			}
			if let Some(w) = &simple.word_or_name {
				push_word(w);
			}
			if let Some(suffix) = &simple.suffix {
				for item in &suffix.0 {
					match item {
						CommandPrefixOrSuffixItem::Word(w) => push_word(w),
						CommandPrefixOrSuffixItem::IoRedirect(r) => redirects.push(r.to_string()),
						_ => {},
					}
				}
			}
			let mut node = json!({
				"kind": "simpleCommand",
				"text": simple.to_string(),
				"words": words,
				"redirects": redirects,
				"substitutions": substitutions,
				"children": [],
			});
			if !substitutions_ok {
				// A word carries substitution syntax the word parser rejected —
				// the caller must treat the piece as unanalyzable.
				node["substitutionsError"] = json!(true);
			}
			node
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
				CompoundCommand::Coprocess(_) => "coprocess",
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
		Command::ExtendedTest(..) => {
			json!({ "kind": "extendedTest", "text": cmd.to_string(), "children": [] })
		},
	}
}

/// Collect command substitutions (`$(…)` and backticks) from a word's
/// rendered text using brush's own word parser, recursing through
/// double-quoted sequences and parameter-expansion value fields (both can
/// nest further substitutions). Returns `false` when a word that carries
/// substitution syntax fails to parse — the caller must not vouch for it.
fn collect_substitutions(word_text: &str, options: &ParserOptions, out: &mut Vec<String>) -> bool {
	let Ok(pieces) = word::parse(word_text, options) else {
		return !(word_text.contains("$(") || word_text.contains('`'));
	};
	for piece in pieces {
		if !collect_piece_substitutions(piece.piece, options, out) {
			return false;
		}
	}
	true
}

fn collect_piece_substitutions(
	piece: WordPiece,
	options: &ParserOptions,
	out: &mut Vec<String>,
) -> bool {
	match piece {
		WordPiece::CommandSubstitution(cmd) | WordPiece::BackquotedCommandSubstitution(cmd) => {
			out.push(cmd);
			true
		},
		WordPiece::DoubleQuotedSequence(seq) | WordPiece::GettextDoubleQuotedSequence(seq) => {
			for item in seq {
				if !collect_piece_substitutions(item.piece, options, out) {
					return false;
				}
			}
			true
		},
		WordPiece::ParameterExpansion(expr) => {
			// Value-carrying expansions (`${x:-$(cmd)}` & friends) can smuggle
			// a command through the default/alternative/pattern strings.
			match &expr {
				ParameterExpr::UseDefaultValues { default_value: Some(v), .. }
				| ParameterExpr::AssignDefaultValues { default_value: Some(v), .. } => {
					return collect_substitutions(v, options, out);
				},
				ParameterExpr::UseAlternativeValue { alternative_value: Some(v), .. } => {
					return collect_substitutions(v, options, out);
				},
				ParameterExpr::IndicateErrorIfNullOrUnset { error_message: Some(v), .. } => {
					return collect_substitutions(v, options, out);
				},
				ParameterExpr::RemoveSmallestSuffixPattern { pattern: Some(v), .. }
				| ParameterExpr::RemoveLargestSuffixPattern { pattern: Some(v), .. }
				| ParameterExpr::RemoveSmallestPrefixPattern { pattern: Some(v), .. }
				| ParameterExpr::RemoveLargestPrefixPattern { pattern: Some(v), .. } => {
					return collect_substitutions(v, options, out);
				},
				ParameterExpr::ReplaceSubstring { pattern, replacement: Some(r), .. } => {
					if !collect_substitutions(pattern, options, out) {
						return false;
					}
					return collect_substitutions(r, options, out);
				},
				_ => {},
			}
			true
		},
		_ => true,
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
	fn command_substitutions_surface() {
		let nodes = parse_json("echo pre-$(date +%s)").expect("parse ok");
		assert_eq!(nodes[0]["substitutions"][0], "date +%s");
	}

	#[test]
	fn backtick_and_double_quoted_substitutions() {
		let nodes = parse_json("echo `whoami` \"$(uname -r)\"").expect("parse ok");
		let subs = nodes[0]["substitutions"].as_array().unwrap();
		assert_eq!(subs.len(), 2);
		assert_eq!(subs[0], "whoami");
		assert_eq!(subs[1], "uname -r");
	}

	#[test]
	fn single_quoted_substitutions_are_literal() {
		let nodes = parse_json("echo '$(echo no)'").expect("parse ok");
		assert_eq!(nodes[0]["substitutions"].as_array().unwrap().len(), 0);
	}

	#[test]
	fn parameter_expansion_value_substitutions() {
		let nodes = parse_json("echo ${x:-$(date +%s)}").expect("parse ok");
		let subs = nodes[0]["substitutions"].as_array().unwrap();
		assert!(subs.iter().any(|s| s == "date +%s"));
	}

	#[test]
	fn pipeline_words_carry_substitutions() {
		let nodes = parse_json("echo $(date) | grep $(whoami)").expect("parse ok");
		assert_eq!(nodes[0]["kind"], "pipeline");
		let children = nodes[0]["children"].as_array().unwrap();
		assert_eq!(children[0]["substitutions"][0], "date");
		assert_eq!(children[1]["substitutions"][0], "whoami");
	}

	#[test]
	fn empty_command_yields_empty_list() {
		let nodes = parse_json("").expect("parse ok");
		assert_eq!(nodes.as_array().unwrap().len(), 0);
	}
}

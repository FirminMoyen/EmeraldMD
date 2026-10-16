//! Parses search queries into a [`Query`] tree.
//!
//! Grammar (juxtaposition is AND, which binds tighter than `OR`):
//!
//! ```text
//! query   := or EOF
//! or      := and ("OR" and)*
//! and     := unary+
//! unary   := "-" unary | primary
//! primary := "(" or ")" | operator primary | word | "phrase" | /regex/ | [property] | [property:value]
//! ```

use std::fmt;

/// Search operators written as `name:` before their operand.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operator {
    File,
    Path,
    Content,
    Tag,
    Line,
    Block,
    Section,
    Task,
    TaskTodo,
    TaskDone,
    MatchCase,
    IgnoreCase,
}

impl Operator {
    fn from_name(name: &str) -> Option<Self> {
        Some(match name.to_ascii_lowercase().as_str() {
            "file" => Self::File,
            "path" => Self::Path,
            "content" => Self::Content,
            "tag" => Self::Tag,
            "line" => Self::Line,
            "block" => Self::Block,
            "section" => Self::Section,
            "task" => Self::Task,
            "task-todo" => Self::TaskTodo,
            "task-done" => Self::TaskDone,
            "match-case" => Self::MatchCase,
            "ignore-case" => Self::IgnoreCase,
            _ => return None,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Term {
    /// Matches as a substring.
    Word(String),
    /// `"exact phrase"`, also a substring match, spaces included.
    Phrase(String),
    /// `/pattern/`.
    Regex(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Query {
    Term(Term),
    And(Vec<Query>),
    Or(Vec<Query>),
    Not(Box<Query>),
    Op(Operator, Box<Query>),
    /// `[name]` or `[name:value]`.
    Property { name: String, value: Option<Box<Query>> },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParseError {
    pub message: String,
    /// Character index in the query where the problem was found.
    pub position: usize,
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} (at character {})", self.message, self.position + 1)
    }
}

impl std::error::Error for ParseError {}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Token {
    LParen,
    RParen,
    Or,
    Minus,
    Op(Operator),
    Term(Term),
    Property { name: String, value: Option<String>, value_position: usize },
}

struct Lexer {
    chars: Vec<char>,
    pos: usize,
}

impl Lexer {
    fn error<T>(&self, message: impl Into<String>, position: usize) -> Result<T, ParseError> {
        Err(ParseError { message: message.into(), position })
    }

    fn tokens(mut self) -> Result<Vec<(Token, usize)>, ParseError> {
        let mut out = Vec::new();
        while self.pos < self.chars.len() {
            let c = self.chars[self.pos];
            let start = self.pos;
            if c.is_whitespace() {
                self.pos += 1;
                continue;
            }
            let token = match c {
                '(' => {
                    self.pos += 1;
                    Token::LParen
                }
                ')' => {
                    self.pos += 1;
                    Token::RParen
                }
                '"' => Token::Term(Term::Phrase(self.quoted()?)),
                '/' => Token::Term(Term::Regex(self.regex()?)),
                '[' => self.property()?,
                '-' if self.chars.get(self.pos + 1).is_some_and(|n| !n.is_whitespace()) => {
                    self.pos += 1;
                    Token::Minus
                }
                _ => self.word(),
            };
            out.push((token, start));
        }
        Ok(out)
    }

    /// A `"phrase"`; `\"` and `\\` are escapes.
    fn quoted(&mut self) -> Result<String, ParseError> {
        let start = self.pos;
        self.pos += 1;
        let mut text = String::new();
        while let Some(&c) = self.chars.get(self.pos) {
            self.pos += 1;
            match c {
                '"' => return Ok(text),
                '\\' if matches!(self.chars.get(self.pos), Some('"' | '\\')) => {
                    text.push(self.chars[self.pos]);
                    self.pos += 1;
                }
                _ => text.push(c),
            }
        }
        self.error("unclosed quote", start)
    }

    /// A `/regex/`; `\/` stands for a slash, other escapes are kept for the regex.
    fn regex(&mut self) -> Result<String, ParseError> {
        let start = self.pos;
        self.pos += 1;
        let mut pattern = String::new();
        while let Some(&c) = self.chars.get(self.pos) {
            self.pos += 1;
            match c {
                '/' if pattern.is_empty() => return self.error("empty regular expression", start),
                '/' => return Ok(pattern),
                '\\' if self.chars.get(self.pos) == Some(&'/') => {
                    pattern.push('/');
                    self.pos += 1;
                }
                '\\' => {
                    pattern.push('\\');
                    if let Some(&next) = self.chars.get(self.pos) {
                        pattern.push(next);
                        self.pos += 1;
                    }
                }
                _ => pattern.push(c),
            }
        }
        self.error("unclosed regular expression (missing closing /)", start)
    }

    /// `[name]` or `[name:value]`; the value is parsed later as a query.
    fn property(&mut self) -> Result<Token, ParseError> {
        let start = self.pos;
        self.pos += 1;
        let mut depth = 0usize;
        let mut in_quote = false;
        let mut body = String::new();
        let mut colon: Option<(usize, usize)> = None;
        while let Some(&c) = self.chars.get(self.pos) {
            self.pos += 1;
            match c {
                '"' => in_quote = !in_quote,
                '[' if !in_quote => depth += 1,
                ']' if !in_quote && depth == 0 => {
                    let (name, value, value_position) = match colon {
                        Some((at, position)) => {
                            (body[..at].trim().to_owned(), Some(body[at + 1..].to_owned()), position)
                        }
                        None => (body.trim().to_owned(), None, 0),
                    };
                    if name.is_empty() {
                        return self.error("property name is missing in [ ]", start);
                    }
                    return Ok(Token::Property { name, value, value_position });
                }
                ']' if !in_quote => depth -= 1,
                ':' if !in_quote && colon.is_none() => colon = Some((body.len(), self.pos)),
                _ => {}
            }
            body.push(c);
        }
        self.error("unclosed [ (missing ])", start)
    }

    /// A bare word, or an `operator:` prefix whose operand follows directly.
    fn word(&mut self) -> Token {
        let start = self.pos;
        while let Some(&c) = self.chars.get(self.pos) {
            if c.is_whitespace() || c == '(' || c == ')' || c == '"' {
                break;
            }
            if c == ':' {
                let name: String = self.chars[start..self.pos].iter().collect();
                if let Some(op) = Operator::from_name(&name) {
                    self.pos += 1;
                    return Token::Op(op);
                }
            }
            self.pos += 1;
        }
        let word: String = self.chars[start..self.pos].iter().collect();
        if word == "OR" { Token::Or } else { Token::Term(Term::Word(word)) }
    }
}

struct Parser {
    tokens: Vec<(Token, usize)>,
    pos: usize,
    end: usize,
}

impl Parser {
    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.pos).map(|(t, _)| t)
    }

    fn position(&self) -> usize {
        self.tokens.get(self.pos).map_or(self.end, |(_, p)| *p)
    }

    fn error<T>(&self, message: impl Into<String>) -> Result<T, ParseError> {
        Err(ParseError { message: message.into(), position: self.position() })
    }

    fn or(&mut self) -> Result<Query, ParseError> {
        let mut parts = vec![self.and()?];
        while self.peek() == Some(&Token::Or) {
            self.pos += 1;
            if matches!(self.peek(), None | Some(Token::RParen | Token::Or)) {
                return self.error("OR needs a search term after it");
            }
            parts.push(self.and()?);
        }
        Ok(if parts.len() == 1 { parts.pop().expect("one part") } else { Query::Or(parts) })
    }

    fn and(&mut self) -> Result<Query, ParseError> {
        let mut parts = Vec::new();
        while !matches!(self.peek(), None | Some(Token::RParen | Token::Or)) {
            parts.push(self.unary()?);
        }
        match parts.len() {
            0 if self.peek() == Some(&Token::Or) => self.error("OR needs a search term before it"),
            0 => self.error("expected a search term"),
            1 => Ok(parts.pop().expect("one part")),
            _ => Ok(Query::And(parts)),
        }
    }

    fn unary(&mut self) -> Result<Query, ParseError> {
        if self.peek() == Some(&Token::Minus) {
            self.pos += 1;
            return Ok(Query::Not(Box::new(self.unary()?)));
        }
        self.primary()
    }

    fn primary(&mut self) -> Result<Query, ParseError> {
        let Some((token, position)) = self.tokens.get(self.pos).cloned() else {
            return self.error("expected a search term");
        };
        self.pos += 1;
        match token {
            Token::LParen => {
                if self.peek() == Some(&Token::RParen) {
                    self.pos -= 1;
                    return self.error("empty parentheses");
                }
                let inner = self.or()?;
                if self.peek() != Some(&Token::RParen) {
                    return Err(ParseError { message: "unclosed ( (missing ))".into(), position });
                }
                self.pos += 1;
                Ok(inner)
            }
            Token::Op(op) => {
                if matches!(self.peek(), None | Some(Token::RParen | Token::Or)) {
                    return Err(ParseError { message: "operator needs a value after the colon".into(), position });
                }
                Ok(Query::Op(op, Box::new(self.unary()?)))
            }
            Token::Term(term) => Ok(Query::Term(term)),
            Token::Property { name, value, value_position } => {
                let value = match value {
                    Some(text) if !text.trim().is_empty() => {
                        let parsed = parse(&text).map_err(|e| ParseError {
                            message: format!("in [{name}:…]: {}", e.message),
                            position: value_position + e.position,
                        })?;
                        Some(Box::new(parsed))
                    }
                    _ => None,
                };
                Ok(Query::Property { name, value })
            }
            Token::RParen => {
                self.pos -= 1;
                self.error("unexpected )")
            }
            Token::Or => {
                self.pos -= 1;
                self.error("OR needs a search term before it")
            }
            Token::Minus => unreachable!("handled by unary"),
        }
    }
}

pub fn parse(query: &str) -> Result<Query, ParseError> {
    let chars: Vec<char> = query.chars().collect();
    let end = chars.len();
    let tokens = Lexer { chars, pos: 0 }.tokens()?;
    if tokens.is_empty() {
        return Err(ParseError { message: "the search is empty".into(), position: 0 });
    }
    let mut parser = Parser { tokens, pos: 0, end };
    let query = parser.or()?;
    if parser.pos < parser.tokens.len() {
        return parser.error("unexpected )");
    }
    Ok(query)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(w: &str) -> Query {
        Query::Term(Term::Word(w.into()))
    }

    fn op(op: Operator, q: Query) -> Query {
        Query::Op(op, Box::new(q))
    }

    #[test]
    fn words_are_and_and_or_binds_looser() {
        assert_eq!(parse("a b").unwrap(), Query::And(vec![word("a"), word("b")]));
        assert_eq!(
            parse("a b OR c").unwrap(),
            Query::Or(vec![Query::And(vec![word("a"), word("b")]), word("c")])
        );
        assert_eq!(parse("a (b OR c)").unwrap(), Query::And(vec![word("a"), Query::Or(vec![word("b"), word("c")])]));
        // Lower-case "or" is an ordinary word.
        assert_eq!(parse("a or b").unwrap(), Query::And(vec![word("a"), word("or"), word("b")]));
    }

    #[test]
    fn negation_phrases_and_regex() {
        assert_eq!(parse("-draft").unwrap(), Query::Not(Box::new(word("draft"))));
        assert_eq!(parse("a - b").unwrap(), Query::And(vec![word("a"), word("-"), word("b")]));
        assert_eq!(parse(r#""star wars""#).unwrap(), Query::Term(Term::Phrase("star wars".into())));
        assert_eq!(parse(r#""say \"hi\"""#).unwrap(), Query::Term(Term::Phrase("say \"hi\"".into())));
        assert_eq!(parse(r"/\d{4}-\d{2}/").unwrap(), Query::Term(Term::Regex(r"\d{4}-\d{2}".into())));
        assert_eq!(parse(r"/a\/b/").unwrap(), Query::Term(Term::Regex("a/b".into())));
        // A slash inside a word is not a regex.
        assert_eq!(parse("a/b").unwrap(), word("a/b"));
    }

    #[test]
    fn operators_take_one_operand() {
        assert_eq!(parse("file:meeting").unwrap(), op(Operator::File, word("meeting")));
        assert_eq!(parse("tag:#work/project").unwrap(), op(Operator::Tag, word("#work/project")));
        assert_eq!(parse(r#"path:"Daily notes""#).unwrap(), op(Operator::Path, Query::Term(Term::Phrase("Daily notes".into()))));
        assert_eq!(
            parse("line:(mix flour)").unwrap(),
            op(Operator::Line, Query::And(vec![word("mix"), word("flour")]))
        );
        assert_eq!(parse("file:a b").unwrap(), Query::And(vec![op(Operator::File, word("a")), word("b")]));
        assert_eq!(parse("-tag:#x").unwrap(), Query::Not(Box::new(op(Operator::Tag, word("#x")))));
        assert_eq!(parse("task-todo:call").unwrap(), op(Operator::TaskTodo, word("call")));
        assert_eq!(
            parse("match-case:HappyCat").unwrap(),
            op(Operator::MatchCase, word("HappyCat"))
        );
        // Unknown prefixes stay words, so URLs and times still work.
        assert_eq!(parse("https://x.y").unwrap(), word("https://x.y"));
        assert_eq!(parse("10:30").unwrap(), word("10:30"));
    }

    #[test]
    fn properties() {
        assert_eq!(parse("[aliases]").unwrap(), Query::Property { name: "aliases".into(), value: None });
        assert_eq!(
            parse("[status:Draft OR Done]").unwrap(),
            Query::Property {
                name: "status".into(),
                value: Some(Box::new(Query::Or(vec![word("Draft"), word("Done")]))),
            }
        );
        assert_eq!(
            parse(r#"[title:"a: b"]"#).unwrap(),
            Query::Property { name: "title".into(), value: Some(Box::new(Query::Term(Term::Phrase("a: b".into())))) }
        );
    }

    #[test]
    fn useful_errors() {
        let err = |q: &str| parse(q).unwrap_err();
        assert_eq!(err("").message, "the search is empty");
        assert_eq!(err("   ").message, "the search is empty");
        assert_eq!(err("\"open").message, "unclosed quote");
        assert_eq!(err("(a b").message, "unclosed ( (missing ))");
        assert_eq!(err("a)").message, "unexpected )");
        assert_eq!(err("()").message, "empty parentheses");
        assert_eq!(err("/ab").message, "unclosed regular expression (missing closing /)");
        assert_eq!(err("file:").message, "operator needs a value after the colon");
        assert_eq!(err("OR a").message, "OR needs a search term before it");
        assert_eq!(err("a OR").message, "OR needs a search term after it");
        assert_eq!(err("[a").message, "unclosed [ (missing ])");
        assert_eq!(err("[:x]").message, "property name is missing in [ ]");
        let nested = err("[status:(a]");
        assert!(nested.message.starts_with("in [status:…]:"), "{}", nested.message);
        assert_eq!(err("a )").position, 2);
    }
}

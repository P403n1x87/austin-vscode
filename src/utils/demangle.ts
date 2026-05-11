// Itanium C++ ABI name demangler with Rust legacy support.
// Reference: https://itanium-cxx-abi.github.io/cxx-abi/abi.html#mangling

const BUILTIN_TYPES: Record<string, string> = {
    'v': 'void', 'w': 'wchar_t', 'b': 'bool', 'c': 'char',
    'a': 'signed char', 'h': 'unsigned char', 's': 'short',
    't': 'unsigned short', 'i': 'int', 'j': 'unsigned int',
    'l': 'long', 'm': 'unsigned long', 'x': 'long long',
    'y': 'unsigned long long', 'n': '__int128',
    'o': 'unsigned __int128', 'f': 'float', 'd': 'double',
    'e': 'long double', 'g': '__float128', 'z': '...',
};

const OPERATORS: Record<string, string> = {
    'nw': 'operator new', 'na': 'operator new[]',
    'dl': 'operator delete', 'da': 'operator delete[]',
    'ps': 'operator+', 'ng': 'operator-',
    'ad': 'operator&', 'de': 'operator*', 'co': 'operator~',
    'pl': 'operator+', 'mi': 'operator-',
    'ml': 'operator*', 'dv': 'operator/',
    'rm': 'operator%', 'an': 'operator&',
    'or': 'operator|', 'eo': 'operator^',
    'aS': 'operator=', 'pL': 'operator+=',
    'mI': 'operator-=', 'mL': 'operator*=',
    'dV': 'operator/=', 'rM': 'operator%=',
    'aN': 'operator&=', 'oR': 'operator|=',
    'eO': 'operator^=', 'ls': 'operator<<',
    'rs': 'operator>>', 'lS': 'operator<<=',
    'rS': 'operator>>=', 'eq': 'operator==',
    'ne': 'operator!=', 'lt': 'operator<',
    'gt': 'operator>', 'le': 'operator<=',
    'ge': 'operator>=', 'ss': 'operator<=>',
    'nt': 'operator!', 'aa': 'operator&&',
    'oo': 'operator||', 'pp': 'operator++',
    'mm': 'operator--', 'cm': 'operator,',
    'pm': 'operator->*', 'pt': 'operator->',
    'cl': 'operator()', 'ix': 'operator[]',
    'qu': 'operator?',
};

class DemangleError extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = 'DemangleError';
    }
}

class ItaniumDemangler {
    private readonly s: string;
    private pos: number = 0;
    private subs: string[] = [];
    private templateParams: string[] = [];
    private isTemplateName: boolean = false;

    constructor(mangled: string) {
        this.s = mangled;
    }

    private peek(n: number = 1): string {
        return this.s.substring(this.pos, this.pos + n);
    }

    private advance(n: number = 1): string {
        const result = this.s.substring(this.pos, this.pos + n);
        this.pos += n;
        return result;
    }

    private tryConsume(prefix: string): boolean {
        if (this.s.startsWith(prefix, this.pos)) {
            this.pos += prefix.length;
            return true;
        }
        return false;
    }

    private expect(ch: string): void {
        if (!this.tryConsume(ch)) {
            throw new DemangleError(`Expected '${ch}' at pos ${this.pos}`);
        }
    }

    private atEnd(): boolean {
        return this.pos >= this.s.length;
    }

    private isDigit(): boolean {
        const c = this.s.charCodeAt(this.pos);
        return c >= 48 && c <= 57;
    }

    private addSub(s: string): string {
        this.subs.push(s);
        return s;
    }

    private parseNumber(): number {
        let n = 0;
        while (!this.atEnd() && this.isDigit()) {
            n = n * 10 + (this.s.charCodeAt(this.pos) - 48);
            this.pos++;
        }
        return n;
    }

    private parseSourceName(): string {
        const len = this.parseNumber();
        if (this.pos + len > this.s.length) {
            throw new DemangleError('Source name extends past end');
        }
        return this.advance(len);
    }

    demangle(): string {
        if (!this.tryConsume('_Z')) {
            throw new DemangleError('Not a mangled name');
        }

        // _ZL: static/internal-linkage symbol — skip the L, parse normally
        this.tryConsume('L');

        // Special names
        if (this.peek() === 'T' || this.peek() === 'G') {
            return this.parseSpecialName();
        }

        const name = this.parseName();

        if (!this.atEnd()) {
            try {
                if (this.isTemplateName) {
                    // For template specializations the first type is the return type
                    const retType = this.parseType();
                    if (this.atEnd()) {
                        return retType + ' ' + name;
                    }
                    const params = this.parseBareFunctionType();
                    return retType + ' ' + name + params;
                }
                return name + this.parseBareFunctionType();
            } catch {
                return name;
            }
        }

        return name;
    }

    private parseSpecialName(): string {
        if (this.tryConsume('TV')) { return 'vtable for ' + this.parseType(); }
        if (this.tryConsume('TT')) { return 'VTT for ' + this.parseType(); }
        if (this.tryConsume('TI')) { return 'typeinfo for ' + this.parseType(); }
        if (this.tryConsume('TS')) { return 'typeinfo name for ' + this.parseType(); }
        if (this.tryConsume('GV')) { return 'guard variable for ' + this.parseName(); }
        throw new DemangleError('Unknown special name');
    }

    private parseName(): string {
        if (this.peek() === 'N') {
            return this.parseNestedName();
        }

        if (this.peek() === 'Z') {
            return this.parseLocalName();
        }

        let prefix = '';
        if (this.tryConsume('St')) {
            prefix = 'std::';
        }

        const name = this.parseUnqualifiedName();
        const fullName = prefix + name;
        this.addSub(fullName);

        if (!this.atEnd() && this.peek() === 'I') {
            this.isTemplateName = true;
            const tArgs = this.parseTemplateArgs();
            return this.addSub(fullName + tArgs);
        }

        return fullName;
    }

    private parseNestedName(): string {
        this.expect('N');

        // CV-qualifiers
        this.parseCVQualifiers();

        const parts: string[] = [];
        let lastSourceName: string | undefined;

        while (!this.atEnd() && this.peek() !== 'E') {
            if (this.isDigit()) {
                const name = this.parseSourceName();
                parts.push(name);
                lastSourceName = name;
                this.isTemplateName = false;
                this.addSub(parts.join('::'));
            } else if (this.peek() === 'I') {
                this.isTemplateName = true;
                const tArgs = this.parseTemplateArgs();
                if (parts.length > 0) {
                    parts[parts.length - 1] += tArgs;
                    this.addSub(parts.join('::'));
                }
            } else if (this.peek(2) === 'C1' || this.peek(2) === 'C2' || this.peek(2) === 'C3') {
                this.advance(2);
                parts.push(lastSourceName || 'constructor');
                this.isTemplateName = false;
                this.addSub(parts.join('::'));
            } else if (this.peek(2) === 'D0' || this.peek(2) === 'D1' || this.peek(2) === 'D2') {
                this.advance(2);
                parts.push('~' + (lastSourceName || 'destructor'));
                this.isTemplateName = false;
                this.addSub(parts.join('::'));
            } else if (this.peek() === 'B') {
                // ABI tag (e.g. B8ne200100) — skip silently
                this.advance();
                this.parseSourceName();
            } else if (this.peek() === 'S') {
                const sub = this.parseSubstitution();
                const subParts = sub.split('::');
                lastSourceName = subParts[subParts.length - 1];
                parts.push(sub);
                this.isTemplateName = false;
                // Per the ABI, a substitution used as a prefix is not re-added
                if (!this.atEnd() && this.peek() === 'I') {
                    this.isTemplateName = true;
                    const tArgs = this.parseTemplateArgs();
                    parts[parts.length - 1] += tArgs;
                    this.addSub(parts.join('::'));
                }
            } else if (this.peek() === 'T') {
                const tp = this.parseTemplateParam();
                parts.push(tp);
                lastSourceName = tp;
                this.isTemplateName = false;
                this.addSub(parts.join('::'));
            } else if (this.peek() === 'L') {
                this.advance();
                while (!this.atEnd() && this.isDigit()) { this.advance(); }
            } else if (this.peek(2) === 'cv') {
                this.advance(2);
                const t = this.parseType();
                parts.push('operator ' + t);
                this.isTemplateName = false;
                this.addSub(parts.join('::'));
            } else {
                const op = this.tryParseOperatorName();
                if (op !== null) {
                    parts.push(op);
                    this.isTemplateName = false;
                    this.addSub(parts.join('::'));
                } else {
                    throw new DemangleError(`Unexpected in nested name at pos ${this.pos}`);
                }
            }
        }

        this.expect('E');
        return parts.join('::');
    }

    private parseLocalName(): string {
        this.expect('Z');
        const encName = this.parseEncoding();
        this.expect('E');

        if (this.tryConsume('s')) {
            return encName + '::string literal';
        }

        if (this.tryConsume('d')) {
            // Default argument
            while (!this.atEnd() && this.isDigit()) { this.advance(); }
            this.expect('_');
            const localName = this.parseName();
            return encName + '::' + localName;
        }

        if (!this.atEnd() && this.peek() !== 'E') {
            const localName = this.parseName();
            return encName + '::' + localName;
        }

        return encName;
    }

    private parseEncoding(): string {
        if (this.peek() === 'T' || this.peek() === 'G') {
            return this.parseSpecialName();
        }

        const savedTemplate = this.isTemplateName;
        this.isTemplateName = false;
        const name = this.parseName();
        const isTemplate = this.isTemplateName;
        this.isTemplateName = savedTemplate;

        if (!this.atEnd() && this.peek() !== 'E') {
            try {
                if (isTemplate) {
                    const retType = this.parseType();
                    if (this.atEnd() || this.peek() === 'E') {
                        return retType + ' ' + name;
                    }
                    const params = this.parseBareFunctionType();
                    return retType + ' ' + name + params;
                }
                return name + this.parseBareFunctionType();
            } catch {
                return name;
            }
        }

        return name;
    }

    private parseUnqualifiedName(lastComponent?: string): string {
        if (this.isDigit()) {
            return this.parseSourceName();
        }

        const two = this.peek(2);

        if (two === 'C1' || two === 'C2' || two === 'C3') {
            this.advance(2);
            return lastComponent || 'constructor';
        }
        if (two === 'D0' || two === 'D1' || two === 'D2') {
            this.advance(2);
            return '~' + (lastComponent || 'destructor');
        }
        if (two === 'cv') {
            this.advance(2);
            return 'operator ' + this.parseType();
        }

        const op = this.tryParseOperatorName();
        if (op !== null) { return op; }

        throw new DemangleError(`Cannot parse unqualified name at pos ${this.pos}`);
    }

    private tryParseOperatorName(): string | null {
        const two = this.peek(2);
        if (OPERATORS[two]) {
            this.advance(2);
            return OPERATORS[two];
        }
        if (this.peek() === 'v' && this.s.length > this.pos + 1) {
            const d = this.s.charCodeAt(this.pos + 1);
            if (d >= 48 && d <= 57) {
                this.advance(2);
                return 'operator ' + this.parseSourceName();
            }
        }
        if (this.peek(2) === 'li') {
            this.advance(2);
            return 'operator""' + this.parseSourceName();
        }
        return null;
    }

    private parseTemplateArgs(): string {
        this.expect('I');
        const args: string[] = [];

        while (!this.atEnd() && this.peek() !== 'E') {
            if (this.peek() === 'X') {
                this.advance();
                const expr = this.skipBalanced();
                args.push(expr);
                this.expect('E');
            } else if (this.peek() === 'L') {
                args.push(this.parseExprPrimary());
            } else if (this.peek() === 'J') {
                this.advance();
                while (!this.atEnd() && this.peek() !== 'E') {
                    args.push(this.parseType());
                }
                this.expect('E');
            } else {
                args.push(this.parseType());
            }
        }

        this.expect('E');
        this.templateParams = args;
        return '<' + args.join(', ') + '>';
    }

    private skipBalanced(): string {
        let depth = 0;
        const start = this.pos;
        while (!this.atEnd()) {
            const c = this.peek();
            if (c === 'E' && depth === 0) { break; }
            if (c === 'I' || c === 'X') { depth++; }
            if (c === 'E') { depth--; }
            this.advance();
        }
        return this.s.substring(start, this.pos);
    }

    private parseExprPrimary(): string {
        this.expect('L');
        if (this.peek() === '_' && this.peek(2) === '_Z') {
            this.advance();
            const enc = this.parseEncoding();
            this.expect('E');
            return enc;
        }
        this.parseType();
        let neg = this.tryConsume('n');
        let val = '';
        while (!this.atEnd() && this.peek() !== 'E') {
            val += this.advance();
        }
        this.expect('E');
        return (neg ? '-' : '') + val;
    }

    private parseTemplateParam(): string {
        this.expect('T');
        let idx: number;
        if (this.tryConsume('_')) {
            idx = 0;
        } else {
            idx = this.parseNumber();
            this.expect('_');
            idx += 1;
        }

        if (idx < this.templateParams.length) {
            return this.templateParams[idx];
        }
        return idx === 0 ? 'T' : `T${idx}`;
    }

    private parseCVQualifiers(): string {
        let quals = '';
        if (this.tryConsume('r')) { quals += ' restrict'; }
        if (this.tryConsume('V')) { quals += ' volatile'; }
        if (this.tryConsume('K')) { quals += ' const'; }
        return quals;
    }

    private parseType(): string {
        if (this.atEnd()) { throw new DemangleError('Unexpected end in type'); }

        const quals = this.parseCVQualifiers();
        if (quals) {
            const inner = this.parseType();
            return this.addSub(inner + quals);
        }

        const c = this.peek();

        // Builtin types (exclude D, N, S, T which have other meanings)
        if (c !== 'D' && c !== 'N' && c !== 'S' && c !== 'T' && c !== 'P'
            && c !== 'R' && c !== 'O' && c !== 'C' && c !== 'G' && c !== 'F'
            && c !== 'A' && c !== 'U' && c !== 'Z' && c !== 'M'
            && BUILTIN_TYPES[c]) {
            this.advance();
            return BUILTIN_TYPES[c];
        }

        if (c === 'D') { return this.parseDType(); }
        if (c === 'P') { this.advance(); return this.addSub(this.parseType() + '*'); }
        if (c === 'R') { this.advance(); return this.addSub(this.parseType() + '&'); }
        if (c === 'O') { this.advance(); return this.addSub(this.parseType() + '&&'); }
        if (c === 'C') { this.advance(); return this.addSub(this.parseType() + ' _Complex'); }
        if (c === 'G') { this.advance(); return this.addSub(this.parseType() + ' _Imaginary'); }

        if (c === 'S') {
            const sub = this.parseSubstitution();
            // After std:: prefix, a source-name may follow (class in std namespace)
            if (sub === 'std' && !this.atEnd() && this.isDigit()) {
                const name = this.parseSourceName();
                const full = 'std::' + name;
                this.addSub(full);
                if (!this.atEnd() && this.peek() === 'I') {
                    return this.addSub(full + this.parseTemplateArgs());
                }
                return full;
            }
            if (!this.atEnd() && this.peek() === 'I') {
                return this.addSub(sub + this.parseTemplateArgs());
            }
            return sub;
        }

        if (c === 'T') {
            const tp = this.parseTemplateParam();
            if (!this.atEnd() && this.peek() === 'I') {
                return this.addSub(tp + this.parseTemplateArgs());
            }
            return tp;
        }

        if (c === 'N') { return this.parseNestedName(); }

        if (this.isDigit()) {
            const name = this.parseSourceName();
            this.addSub(name);
            if (!this.atEnd() && this.peek() === 'I') {
                return this.addSub(name + this.parseTemplateArgs());
            }
            return name;
        }

        if (c === 'F') {
            this.advance();
            const ret = this.parseType();
            const params: string[] = [];
            while (!this.atEnd() && this.peek() !== 'E') {
                params.push(this.parseType());
            }
            this.expect('E');
            return this.addSub(`${ret} (${params.join(', ')})`);
        }

        if (c === 'A') {
            this.advance();
            let size = '';
            while (!this.atEnd() && this.peek() !== '_') { size += this.advance(); }
            this.expect('_');
            return this.addSub(this.parseType() + `[${size}]`);
        }

        if (c === 'U') {
            this.advance();
            const qual = this.parseSourceName();
            const inner = this.parseType();
            return this.addSub(`${inner} ${qual}`);
        }

        if (c === 'M') {
            this.advance();
            const cls = this.parseType();
            const member = this.parseType();
            return this.addSub(`${member} ${cls}::*`);
        }

        throw new DemangleError(`Unrecognized type at pos ${this.pos}: '${this.peek(5)}'`);
    }

    private parseDType(): string {
        const two = this.peek(2);
        const dTypes: Record<string, string> = {
            'Dd': 'decimal64', 'De': 'decimal128', 'Df': 'decimal32',
            'Dh': 'half', 'Di': 'char32_t', 'Ds': 'char16_t',
            'Da': 'auto', 'Dc': 'decltype(auto)', 'Dn': 'std::nullptr_t',
            'Du': 'char8_t',
        };
        if (dTypes[two]) {
            this.advance(2);
            return dTypes[two];
        }
        if (two === 'Dp') {
            this.advance(2);
            return this.parseType() + '...';
        }
        if (two === 'DT' || two === 'Dt') {
            this.advance(2);
            const expr = this.skipBalanced();
            this.expect('E');
            return `decltype(${expr})`;
        }
        throw new DemangleError(`Unknown D-type: ${two}`);
    }

    private parseSubstitution(): string {
        this.expect('S');

        // Well-known substitutions are never added to the substitution table
        if (this.tryConsume('t')) { return 'std'; }
        if (this.tryConsume('a')) { return 'std::allocator'; }
        if (this.tryConsume('b')) { return 'std::basic_string'; }
        if (this.tryConsume('s')) { return 'std::string'; }
        if (this.tryConsume('i')) { return 'std::istream'; }
        if (this.tryConsume('o')) { return 'std::ostream'; }
        if (this.tryConsume('d')) { return 'std::iostream'; }

        if (this.tryConsume('_')) {
            return this.subs[0] || '';
        }

        let seqId = 0;
        while (!this.atEnd() && this.peek() !== '_') {
            const ch = this.s[this.pos];
            if (ch >= '0' && ch <= '9') {
                seqId = seqId * 36 + (ch.charCodeAt(0) - 48);
            } else if (ch >= 'A' && ch <= 'Z') {
                seqId = seqId * 36 + (ch.charCodeAt(0) - 55);
            } else {
                throw new DemangleError(`Invalid substitution char: ${ch}`);
            }
            this.pos++;
        }
        this.expect('_');
        return this.subs[seqId + 1] || '';
    }

    private parseBareFunctionType(): string {
        const params: string[] = [];
        while (!this.atEnd()) {
            params.push(this.parseType());
        }
        if (params.length === 1 && params[0] === 'void') {
            return '()';
        }
        return '(' + params.join(', ') + ')';
    }
}


// Strip Rust legacy hash suffix (::h followed by 16 hex chars)
function stripRustHash(name: string): string {
    return name.replace(/::h[0-9a-f]{16}$/, '');
}

// Decode Rust legacy $..$ escape sequences embedded in Itanium source-names.
const RUST_ESCAPES: Record<string, string> = {
    '$LT$': '<', '$GT$': '>', '$LP$': '(', '$RP$': ')',
    '$BP$': '*', '$RF$': '&', '$C$': ',', '$SP$': '@',
    '$u20$': ' ', '$u27$': "'", '$u5b$': '[', '$u5d$': ']',
    '$u7b$': '{', '$u7d$': '}', '$u7e$': '~',
};

function decodeRustEscapes(name: string): string {
    if (!name.includes('$')) { return name; }
    return name.replace(/\$[A-Za-z0-9_]+\$/g, (match) => {
        const known = RUST_ESCAPES[match];
        if (known) { return known; }
        // Generic $uXXXX$ unicode escapes
        const m = match.match(/^\$u([0-9a-fA-F]+)\$$/);
        if (m) { return String.fromCodePoint(parseInt(m[1], 16)); }
        return match;
    });
}


// ---------------------------------------------------------------------------
// Cython demangling (__pyx_pw_, __pyx_pf_, __pyx_f_)
// ---------------------------------------------------------------------------

// Cython encodes the dotted module path, class, and function name as
// length-prefixed segments separated by '_'.  For __pyx_pw_ (wrapper)
// symbols, the final segment has a numeric method-index counter that
// must be stripped.

const CYTHON_PREFIX_RE = /^__pyx_(?:pw|pf|gb|f)_/;
const CYTHON_FUSE_RE = /^__pyx_fuse_\d+/;

function demangleCython(name: string): string | null {
    // Fused-type specializations: strip the __pyx_fuse_N prefix, then fall through
    const stripped = name.replace(CYTHON_FUSE_RE, '');
    if (stripped !== name) { name = stripped; }

    const m = name.match(CYTHON_PREFIX_RE);
    if (!m) { return null; }

    const body = name.substring(m[0].length);
    const components: string[] = [];
    let pos = 0;

    while (pos < body.length) {
        // Read a length-prefix number
        const numStart = pos;
        while (pos < body.length && body.charCodeAt(pos) >= 48 && body.charCodeAt(pos) <= 57) {
            pos++;
        }
        if (pos === numStart) { break; } // no digit → rest is method name

        const n = parseInt(body.substring(numStart, pos), 10);

        // Must be able to read exactly n characters
        if (pos + n > body.length) { pos = numStart; break; }

        const component = body.substring(pos, pos + n);
        pos += n;

        if (pos === body.length) {
            // End of string — last component (e.g. __pyx_f_ with no trailing method)
            components.push(component);
            break;
        }

        if (body[pos] !== '_') {
            // n chars didn't land on a '_' → not a valid length-prefix
            pos = numStart;
            break;
        }

        const afterSep = pos + 1;

        if (afterSep < body.length && body.charCodeAt(afterSep) >= 48 && body.charCodeAt(afterSep) <= 57) {
            // Separator followed by digit → more path components
            components.push(component);
            pos = afterSep;
            continue;
        }

        // Separator NOT followed by digit.  Decide whether this is the
        // last path component or a counter+method that got half-parsed.
        // Reject short underscore-only fragments and dunder prefixes —
        // those are artefacts of a counter colliding with __method__.
        if (component.length <= 1 || component.startsWith('__')) {
            pos = numStart;
            break;
        }

        // Accept as last path component; remainder is the method name
        components.push(component);
        pos = afterSep;
        break;
    }

    const remaining = body.substring(pos);
    // Strip leading counter digits (e.g. "1__init__" → "__init__")
    const method = remaining.replace(/^\d+/, '') || remaining;

    if (components.length === 0 && !method) { return null; }

    if (method) { components.push(method); }
    return components.join('.');
}


// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const cache = new Map<string, string>();

/**
 * Demangle a symbol name (C++ Itanium ABI, Rust legacy, Cython).
 * Returns the original name if it is not mangled or demangling fails.
 */
export function demangle(name: string): string {
    const cached = cache.get(name);
    if (cached !== undefined) { return cached; }

    let result: string;
    try {
        // Cython symbols (__pyx_pw_, __pyx_pf_, __pyx_f_)
        const cython = demangleCython(name);
        if (cython !== null) {
            result = cython;
        } else {
            // Handle macOS extra leading underscore (__Z → _Z)
            const input = name.startsWith('__Z') ? name.substring(1) : name;
            if (input.startsWith('_Z')) {
                result = decodeRustEscapes(stripRustHash(new ItaniumDemangler(input).demangle()));
            } else {
                result = name;
            }
        }
    } catch {
        result = name;
    }

    cache.set(name, result);
    return result;
}

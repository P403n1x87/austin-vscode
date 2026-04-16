import * as assert from 'assert';
import { demangle } from '../../utils/demangle';


suite('demangle — pass-through', () => {

    test('returns plain C name unchanged', () => {
        assert.strictEqual(demangle('printf'), 'printf');
    });

    test('returns empty string unchanged', () => {
        assert.strictEqual(demangle(''), '');
    });

    test('returns Python scope unchanged', () => {
        assert.strictEqual(demangle('keep_cpu_busy'), 'keep_cpu_busy');
    });

    test('returns <unknown> unchanged', () => {
        assert.strictEqual(demangle('<unknown>'), '<unknown>');
    });
});


suite('demangle — simple C++ functions', () => {

    test('demanges simple void function', () => {
        // void foo()
        assert.strictEqual(demangle('_Z3foov'), 'foo()');
    });

    test('demangles function with int param', () => {
        // int bar(int)
        assert.strictEqual(demangle('_Z3bari'), 'bar(int)');
    });

    test('demangles function with multiple params', () => {
        // void func(int, double, char)
        assert.strictEqual(demangle('_Z4funcidc'), 'func(int, double, char)');
    });

    test('demangles function with pointer param', () => {
        // void process(int*)
        assert.strictEqual(demangle('_Z7processPi'), 'process(int*)');
    });

    test('demangles function with const ref param', () => {
        // void read(const int&)
        assert.strictEqual(demangle('_Z4readRKi'), 'read(int const&)');
    });
});


suite('demangle — nested names (namespaces/classes)', () => {

    test('demangles single namespace', () => {
        // void ns::func()
        assert.strictEqual(demangle('_ZN2ns4funcEv'), 'ns::func()');
    });

    test('demangles deep nesting', () => {
        // void a::b::c::d()
        assert.strictEqual(demangle('_ZN1a1b1c1dEv'), 'a::b::c::d()');
    });

    test('demangles class method', () => {
        // void MyClass::method(int)
        assert.strictEqual(demangle('_ZN7MyClass6methodEi'), 'MyClass::method(int)');
    });

    test('demangles constructor', () => {
        // Foo::Foo()
        assert.strictEqual(demangle('_ZN3FooC1Ev'), 'Foo::Foo()');
    });

    test('demangles C2 constructor', () => {
        assert.strictEqual(demangle('_ZN3FooC2Ev'), 'Foo::Foo()');
    });

    test('demangles destructor', () => {
        // Foo::~Foo()
        assert.strictEqual(demangle('_ZN3FooD1Ev'), 'Foo::~Foo()');
    });

    test('demangles D0 destructor', () => {
        assert.strictEqual(demangle('_ZN3FooD0Ev'), 'Foo::~Foo()');
    });
});


suite('demangle — templates', () => {

    test('demangles simple template function', () => {
        // void f<int>(int)
        // _Z1fIiEvT_ = f, template<int>, return void, param T0=int
        assert.strictEqual(demangle('_Z1fIiEvT_'), 'void f<int>(int)');
    });

    test('demangles class template method', () => {
        // void Vec<int>::push(int)
        assert.strictEqual(demangle('_ZN3VecIiE4pushEi'), 'Vec<int>::push(int)');
    });

    test('demangles template with multiple args', () => {
        // void Map<int, double>::insert()
        assert.strictEqual(demangle('_ZN3MapIidE6insertEv'), 'Map<int, double>::insert()');
    });
});


suite('demangle — operators', () => {

    test('demangles operator+', () => {
        // A::operator+(int)
        assert.strictEqual(demangle('_ZN1AplEi'), 'A::operator+(int)');
    });

    test('demangles operator==', () => {
        // bool A::operator==(A const&)
        assert.strictEqual(demangle('_ZN1AeqERKS_'), 'A::operator==(A const&)');
    });

    test('demangles operator()', () => {
        // void Fn::operator()(int)
        assert.strictEqual(demangle('_ZN2FnclEi'), 'Fn::operator()(int)');
    });

    test('demangles operator[]', () => {
        assert.strictEqual(demangle('_ZN3ArrixEi'), 'Arr::operator[](int)');
    });
});


suite('demangle — special names', () => {

    test('demangles vtable', () => {
        assert.strictEqual(demangle('_ZTV3Foo'), 'vtable for Foo');
    });

    test('demangles typeinfo', () => {
        assert.strictEqual(demangle('_ZTI3Foo'), 'typeinfo for Foo');
    });

    test('demangles typeinfo name', () => {
        assert.strictEqual(demangle('_ZTS3Foo'), 'typeinfo name for Foo');
    });
});


suite('demangle — well-known substitutions', () => {

    test('demangles std:: prefix (St)', () => {
        // std::sort(...)
        assert.strictEqual(demangle('_ZSt4sortv'), 'std::sort()');
    });

    test('demangles std::string (Ss)', () => {
        // void f(std::string)
        assert.strictEqual(demangle('_Z1fSs'), 'f(std::string)');
    });

    test('demangles std::allocator (Sa)', () => {
        assert.strictEqual(demangle('_Z1fSa'), 'f(std::allocator)');
    });
});


suite('demangle — Rust legacy mangling', () => {

    test('demangles Rust legacy name and strips hash', () => {
        // _ZN4core3fmt5write17h0123456789abcdefE → core::fmt::write
        assert.strictEqual(
            demangle('_ZN4core3fmt5write17h0123456789abcdefE'),
            'core::fmt::write'
        );
    });

    test('does not strip non-hash suffix', () => {
        // Regular C++ name that happens to have an h-prefix component
        assert.strictEqual(
            demangle('_ZN3foo5helloEv'),
            'foo::hello()'
        );
    });
});


suite('demangle — Rust $..$ escape sequences', () => {

    test('decodes $LT$ and $GT$ to angle brackets', () => {
        // _ZN4core6option15Option$LT$T$GT$6unwrap17habcdef0123456789E
        // → core::option::Option<T>::unwrap
        assert.strictEqual(
            demangle('_ZN4core6option15Option$LT$T$GT$6unwrap17habcdef0123456789E'),
            'core::option::Option<T>::unwrap'
        );
    });

    test('decodes $C$ to comma', () => {
        assert.strictEqual(
            demangle('_ZN43Box$LT$dyn$u20$Fn$LP$i32$C$$u20$i32$RP$$GT$3new17habcdef0123456789E'),
            'Box<dyn Fn(i32, i32)>::new'
        );
    });

    test('decodes $RF$ to &', () => {
        assert.strictEqual(
            demangle('_ZN5slice15$RF$$u5b$T$u5d$3len17habcdef0123456789E'),
            'slice::&[T]::len'
        );
    });

    test('leaves name alone when no $ escapes present', () => {
        assert.strictEqual(demangle('_Z3foov'), 'foo()');
    });
});


suite('demangle — macOS leading underscore', () => {

    test('handles __Z prefix (macOS Mach-O)', () => {
        assert.strictEqual(demangle('__Z3foov'), 'foo()');
    });

    test('handles __ZN prefix', () => {
        assert.strictEqual(demangle('__ZN3Bar3bazEi'), 'Bar::baz(int)');
    });
});


suite('demangle — ABI tags', () => {

    test('skips ABI tag on destructor', () => {
        // std::__1::unique_ptr<...>::~unique_ptr[abi:ne200100]()
        assert.strictEqual(
            demangle('_ZNSt3__110unique_ptrIN8Security12KeychainCore13TrustSettingsENS_14default_deleteIS3_EEED1B8ne200100Ev'),
            'std::__1::unique_ptr<Security::KeychainCore::TrustSettings, std::__1::default_delete<Security::KeychainCore::TrustSettings>>::~unique_ptr()'
        );
    });

    test('skips ABI tag on source name', () => {
        // ns::func[abi:v2]()
        assert.strictEqual(
            demangle('_ZN2ns4funcB2v2Ev'),
            'ns::func()'
        );
    });
});


suite('demangle — static/internal linkage (_ZL)', () => {

    test('demangles _ZL simple function', () => {
        // static void helper()
        assert.strictEqual(demangle('_ZL6helperv'), 'helper()');
    });

    test('demangles _ZL nested name', () => {
        // static void ns::init(int)
        assert.strictEqual(demangle('_ZLN2ns4initEi'), 'ns::init(int)');
    });
});


suite('demangle — Cython symbols', () => {

    test('demangles __pyx_pw_ wrapper with dunder method', () => {
        assert.strictEqual(
            demangle('__pyx_pw_7ddtrace_8internal_9_encoding_11StringTable_1__init__'),
            'ddtrace.internal._encoding.StringTable.__init__'
        );
    });

    test('demangles __pyx_pw_ wrapper with plain method', () => {
        assert.strictEqual(
            demangle('__pyx_pw_7ddtrace_8internal_9_encoding_11StringTable_3index'),
            'ddtrace.internal._encoding.StringTable.index'
        );
    });

    test('demangles __pyx_pw_ wrapper with __len__', () => {
        assert.strictEqual(
            demangle('__pyx_pw_7ddtrace_8internal_9_encoding_11StringTable_5__len__'),
            'ddtrace.internal._encoding.StringTable.__len__'
        );
    });

    test('demangles __pyx_pf_ implementation', () => {
        assert.strictEqual(
            demangle('__pyx_pf_7ddtrace_8internal_9_encoding_11StringTable___init__'),
            'ddtrace.internal._encoding.StringTable.__init__'
        );
    });

    test('demangles __pyx_f_ cdef function', () => {
        assert.strictEqual(
            demangle('__pyx_f_7ddtrace_9profiling_9collector_8_sampler_14CaptureSampler_capture'),
            'ddtrace.profiling.collector._sampler.CaptureSampler.capture'
        );
    });

    test('demangles property getter', () => {
        assert.strictEqual(
            demangle('__pyx_pf_7ddtrace_8internal_9_encoding_18MsgpackStringTable_4size___get__'),
            'ddtrace.internal._encoding.MsgpackStringTable.size.__get__'
        );
    });

    test('demangles property setter with counter', () => {
        assert.strictEqual(
            demangle('__pyx_pf_7ddtrace_8internal_9_encoding_15BufferedEncoder_8max_size_2__set__'),
            'ddtrace.internal._encoding.BufferedEncoder.max_size.__set__'
        );
    });

    test('returns non-pyx names unchanged', () => {
        assert.strictEqual(demangle('__pyx_tp_new_SomeType'), '__pyx_tp_new_SomeType');
    });

    test('module-level function', () => {
        assert.strictEqual(
            demangle('__pyx_pw_7ddtrace_8internal_9_encoding_1packb'),
            'ddtrace.internal._encoding.packb'
        );
    });
});


suite('demangle — graceful failure', () => {

    test('returns original on truncated mangled name', () => {
        assert.strictEqual(demangle('_ZN3Foo'), '_ZN3Foo');
    });

    test('returns original on invalid mangled name', () => {
        assert.strictEqual(demangle('_Z$$invalid'), '_Z$$invalid');
    });

    test('caches results (second call returns same value)', () => {
        const first = demangle('_Z3foov');
        const second = demangle('_Z3foov');
        assert.strictEqual(first, second);
        assert.strictEqual(first, 'foo()');
    });
});

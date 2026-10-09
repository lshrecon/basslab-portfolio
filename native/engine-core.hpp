#pragma once
// Pure arithmetic and bounded single-producer/single-consumer state.
// This header has no COM, device, filesystem, or detector operations.
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <intrin.h>
namespace basslab {
constexpr std::uint64_t Fs=44100, MaxAge=26460000, WaitFrames=24078600, Lead=55125;
inline bool agePermitted(std::uint64_t cEnd,std::uint64_t vEnd){return vEnd>=cEnd&&vEnd-cEnd<=MaxAge;}
inline std::uint64_t decimal(const std::string& s) {
    if(s.empty() || (s.size()>1 && s[0]=='0')) throw std::runtime_error("noncanonical uint64");
    std::uint64_t n=0;
    for(char c:s) { if(c<'0'||c>'9'||n>(UINT64_MAX-static_cast<unsigned>(c-'0'))/10) throw std::runtime_error("uint64 overflow"); n=n*10+static_cast<unsigned>(c-'0'); }
    return n;
}
inline std::uint64_t add(std::uint64_t a,std::uint64_t b) { if(a>UINT64_MAX-b) throw std::runtime_error("frame overflow"); return a+b; }
inline std::int64_t difference(std::uint64_t a,std::uint64_t b) {
    const auto d=a>=b?a-b:b-a;
    if(d>static_cast<std::uint64_t>(INT64_MAX)) throw std::runtime_error("difference overflow");
    return a>=b?static_cast<std::int64_t>(d):-static_cast<std::int64_t>(d);
}
inline std::int32_t decode24(const unsigned char* p) {
    const auto u=static_cast<std::uint32_t>(p[0])|(static_cast<std::uint32_t>(p[1])<<8)|(static_cast<std::uint32_t>(p[2])<<16);
    return (u&0x800000U)?static_cast<std::int32_t>(u)-16777216:static_cast<std::int32_t>(u);
}
inline float decodeFloat24(const unsigned char* p) { return static_cast<float>(decode24(p))/8388608.0f; }
struct Slice { std::uint64_t first=0; std::uint32_t offset=0,count=0; };
inline Slice slice(std::uint64_t packet,std::uint32_t count,std::uint64_t first,std::uint64_t end) {
    const auto pEnd=add(packet,count); const auto lo=(packet>first?packet:first), hi=(pEnd<end?pEnd:end);
    if(lo>=hi) return {};
    return {lo,static_cast<std::uint32_t>(lo-packet),static_cast<std::uint32_t>(hi-lo)};
}
class Continuity {
    std::optional<std::uint64_t> next_;
public:
    void accept(std::uint64_t frame,std::uint32_t count,std::uint32_t flags) {
        if(flags&~2U) throw std::runtime_error("capture invalid/unknown flags");
        if(!count) return;
        if(next_ && frame!=*next_) throw std::runtime_error(frame>*next_?"capture gap":"capture overlap");
        next_=add(frame,count);
    }
};
// Unsigned 128-bit operations keep reservation rounding exact on MSVC x64.
struct U128 { std::uint64_t hi=0,lo=0; };
inline int compare(U128 a,U128 b) { return a.hi!=b.hi?(a.hi>b.hi?1:-1):a.lo==b.lo?0:a.lo>b.lo?1:-1; }
inline U128 plus(U128 a,U128 b) { U128 r; unsigned char c=_addcarry_u64(0,a.lo,b.lo,&r.lo); if(_addcarry_u64(c,a.hi,b.hi,&r.hi))throw std::runtime_error("128 overflow");return r; }
inline U128 minus(U128 a,U128 b) { if(compare(a,b)<0)throw std::runtime_error("128 negative");U128 r;auto c=_subborrow_u64(0,a.lo,b.lo,&r.lo);_subborrow_u64(c,a.hi,b.hi,&r.hi);return r; }
inline U128 times(std::uint64_t a,std::uint64_t b) { U128 r; r.lo=_umul128(a,b,&r.hi);return r; }
inline U128 times(U128 a,std::uint64_t b) { U128 low=times(a.lo,b),high=times(a.hi,b);if(high.hi || high.lo>UINT64_MAX-low.hi)throw std::runtime_error("128 multiply overflow");return{low.hi+high.lo,low.lo}; }
struct Signed128 { bool neg=false; U128 n; };
inline Signed128 signedPlus(Signed128 a,Signed128 b) { if(a.neg==b.neg)return{a.neg,plus(a.n,b.n)};int c=compare(a.n,b.n);return c>=0?Signed128{a.neg,minus(a.n,b.n)}:Signed128{b.neg,minus(b.n,a.n)}; }
inline Signed128 product(std::int64_t a,std::uint64_t b) { return{a<0,times(static_cast<std::uint64_t>(a<0?-a:a),b)}; }
inline std::uint64_t nearest(U128 n,U128 den,double approximation) {
    if(compare(den,{})==0 || !std::isfinite(approximation)||approximation<0 || approximation>9.0e15)throw std::runtime_error("reservation quotient range");
    auto q=static_cast<std::uint64_t>(std::floor(approximation));
    unsigned steps=0;
    while(compare(times(den,q),n)>0) { if(!q || ++steps>4)throw std::runtime_error("arithmetic estimate mismatch");--q; }
    while(q<UINT64_MAX && compare(times(den,q+1),n)<=0) { if(++steps>4)throw std::runtime_error("arithmetic estimate mismatch");++q; }
    auto remainder=minus(n,times(den,q));
    return compare(times(remainder,2),den)>=0?add(q,1):q;
}
struct Anchor { std::string id;std::uint64_t position=0,frequency=0,qpc=0; };
class Anchors {
    std::optional<Anchor> previous_, latest_, lastObserved_;
public:
    void accept(const Anchor& a) {
        if(!a.frequency)throw std::runtime_error("zero clock frequency");
        if(lastObserved_){
            if(a.frequency!=lastObserved_->frequency||a.position<lastObserved_->position||a.qpc<lastObserved_->qpc)throw std::runtime_error("raw clock regression/change");
            if(a.position>lastObserved_->position&&a.qpc==lastObserved_->qpc)throw std::runtime_error("raw advancing position with equal QPC");
        }
        lastObserved_=a;
        if(latest_) {
            if(a.frequency!=latest_->frequency || a.position<latest_->position || a.qpc<latest_->qpc)throw std::runtime_error("clock regression/change");
            if(a.position==latest_->position)return; // Preserved in raw ledger; not interpolation denominator.
            if(a.qpc==latest_->qpc)throw std::runtime_error("clock non-increasing QPC");
            previous_=latest_;
        }
        latest_=a;
    }
    bool ready()const{return previous_.has_value()&&latest_.has_value();}
    const Anchor& a()const {if(!ready())throw std::runtime_error("anchors unavailable");return *previous_;}
    const Anchor& b()const {if(!ready())throw std::runtime_error("anchors unavailable");return *latest_;}
};
struct Prediction { std::uint64_t renderFrame=0;double qpcOffset100ns=0,renderApprox=0,captureHorizonFrames=0,renderHorizonFrames=0; };
// A future target is not committed until BOTH endpoint/time horizons fit.
// This is normal scheduling progress, not a retry or a shift of the target.
inline bool outsideFutureWindow(std::uint64_t target,const Anchors& render,const Anchors& capture,std::uint32_t bufferFrames){
    const auto& r0=render.a();const auto& r1=render.b();const auto& c0=capture.a();const auto& c1=capture.b();
    const auto dc=difference(target,c1.position);if(dc<0)return false;
    const double cq=static_cast<double>(dc)*static_cast<double>(c1.qpc-c0.qpc)/static_cast<double>(c1.position-c0.position);
    const double rq=static_cast<double>(difference(c1.qpc,r1.qpc))+cq;if(rq<0)return false;
    const double rf=rq*(static_cast<double>(r1.position-r0.position)/static_cast<double>(r1.qpc-r0.qpc))*(static_cast<double>(Fs)/static_cast<double>(r1.frequency));
    const double frames=(std::min)(static_cast<double>(bufferFrames)*2,static_cast<double>(Fs)*0.05);
    const double time=(std::min)(static_cast<double>(bufferFrames)*2*10000000.0/static_cast<double>(Fs),500000.0);
    return static_cast<double>(dc)>frames||rf>frames||cq>time||rq>time;
}
inline Prediction predict(std::uint64_t target,const Anchors& render,const Anchors& capture,std::uint32_t bufferFrames) {
    const auto& r0=render.a(); const auto& r1=render.b();const auto& c0=capture.a();const auto& c1=capture.b();
    if(c0.frequency!=Fs||c1.frequency!=Fs||!bufferFrames)throw std::runtime_error("reservation units");
    const auto rdq=r1.qpc-r0.qpc,cdq=c1.qpc-c0.qpc,rdp=r1.position-r0.position,cdp=c1.position-c0.position;
    if(rdq>500000 || cdq>500000)throw std::runtime_error("anchor coverage exceeds 50ms");
    const auto dc=difference(target,c1.position),dq=difference(c1.qpc,r1.qpc);
    const double qoff=static_cast<double>(dq)+static_cast<double>(dc)*static_cast<double>(cdq)/static_cast<double>(cdp);
    const double ch=static_cast<double>(dc),rh=qoff*(static_cast<double>(rdp)/static_cast<double>(rdq))*(static_cast<double>(Fs)/static_cast<double>(r1.frequency));
    const double captureQoff=static_cast<double>(dc)*static_cast<double>(cdq)/static_cast<double>(cdp);
    const double maxH=(std::min)(static_cast<double>(bufferFrames)*2,static_cast<double>(Fs)*0.05);
    const double maxTime=static_cast<double>(bufferFrames)*2*10000000.0/static_cast<double>(Fs);
    if(ch<0||qoff<0||qoff>500000||captureQoff>500000||qoff>maxTime||captureQoff>maxTime||ch>maxH||rh>maxH)throw std::runtime_error("reservation prediction horizon");
    // R = Fs * [Pr1*rdq*cdp + ((Qc1-Qr1)*cdp+(E-Dc1)*cdq)*rdp] /(Fr*rdq*cdp).
    Signed128 qNumerator=signedPlus(product(dq,cdp),product(dc,cdq));
    Signed128 pNumerator=signedPlus({false,times(times(r1.position,rdq),cdp)},{qNumerator.neg,times(qNumerator.n,rdp)});
    if(pNumerator.neg)throw std::runtime_error("negative render prediction");
    const U128 n=times(pNumerator.n,Fs),d=times(times(r1.frequency,rdq),cdp);
    const double approx=(static_cast<double>(r1.position)+qoff*static_cast<double>(rdp)/static_cast<double>(rdq))*static_cast<double>(Fs)/static_cast<double>(r1.frequency);
    return{nearest(n,d,approx),qoff,approx,ch,rh};
}
#pragma warning(push)
#pragma warning(disable:4324) // Intentional cache-line separation of producer/consumer atomics.
template<class T,std::size_t Capacity> class Spsc {
    static_assert(Capacity>1);
    std::array<std::optional<T>,Capacity> slots_;
    alignas(64) std::atomic<std::size_t> read_{0};
    alignas(64) std::atomic<std::size_t> write_{0};
public:
    bool push(T value) {const auto w=write_.load(std::memory_order_relaxed),next=(w+1)%Capacity;if(next==read_.load(std::memory_order_acquire))return false;slots_[w].emplace(std::move(value));write_.store(next,std::memory_order_release);return true;}
    bool pop(T& result) {const auto r=read_.load(std::memory_order_relaxed);if(r==write_.load(std::memory_order_acquire))return false;result=std::move(*slots_[r]);slots_[r].reset();read_.store((r+1)%Capacity,std::memory_order_release);return true;}
};
#pragma warning(pop)
} // namespace basslab

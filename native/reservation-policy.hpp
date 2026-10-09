#pragma once
#include "engine-core.hpp"
#include <deque>
namespace basslab {
constexpr const char* ReservationVersion="lock-history-qpc-v1";
constexpr std::uint64_t HistoryWindow=5000000,HistoryMinimum=4000000,ReserveLead=8820,ReserveMinimumLead=6615,ReserveMaximumQpc=3500000,ReserveAhead=882;
class ReservationHistory {
    Anchors guard_;std::deque<Anchor> values_;
public:
    void accept(const Anchor& a){guard_.accept(a);if(!values_.empty()&&a.position==values_.back().position)return;values_.push_back(a);while(values_.size()>1&&a.qpc-values_.front().qpc>HistoryWindow)values_.pop_front();if(values_.size()>2048)throw std::runtime_error("reservation history capacity");}
    bool available()const{return !values_.empty();}
    const Anchor& latest()const{if(values_.empty())throw std::runtime_error("reservation history missing");return values_.back();}
    const Anchor& oldest()const{if(values_.size()<2||values_.back().qpc-values_.front().qpc<HistoryMinimum)throw std::runtime_error("reservation history insufficient at deadline");return values_.front();}
};
struct LockedReservation {Prediction prediction;Anchor captureOld,captureLatest,renderOld,renderLatest;std::uint64_t writeFirst=0,triggerCaptureFrame=0;};
inline std::optional<LockedReservation> reserveDue(std::uint64_t target,std::uint64_t writeFirst,const ReservationHistory& render,const ReservationHistory& capture){
    if(!capture.available())return std::nullopt;
    const auto& c1=capture.latest();if(target>c1.position&&target-c1.position>ReserveLead)return std::nullopt;
    if(target<c1.position||target-c1.position<ReserveMinimumLead)throw std::runtime_error("reservation deadline missed");
    const auto& c0=capture.oldest();const auto& r1=render.latest();const auto& r0=render.oldest();
    if(c1.frequency!=Fs||c0.frequency!=Fs||r1.frequency!=r0.frequency)throw std::runtime_error("reservation clock units");
    const auto rdq=r1.qpc-r0.qpc,cdq=c1.qpc-c0.qpc,rdp=r1.position-r0.position,cdp=c1.position-c0.position;
    const auto dc=difference(target,c1.position),dq=difference(c1.qpc,r1.qpc);
    const double cq=static_cast<double>(dc)*static_cast<double>(cdq)/static_cast<double>(cdp);
    const double rq=static_cast<double>(dq)+cq;
    if(cq<0||rq<0||cq>ReserveMaximumQpc||rq>ReserveMaximumQpc)throw std::runtime_error("reservation prediction horizon");
    const auto qnum=signedPlus(product(dq,cdp),product(dc,cdq));
    const auto pnum=signedPlus({false,times(times(r1.position,rdq),cdp)},{qnum.neg,times(qnum.n,rdp)});
    if(pnum.neg)throw std::runtime_error("negative reservation");
    const auto n=times(pnum.n,Fs),den=times(times(r1.frequency,rdq),cdp);
    const double approx=(static_cast<double>(r1.position)+rq*static_cast<double>(rdp)/static_cast<double>(rdq))*static_cast<double>(Fs)/static_cast<double>(r1.frequency);
    const auto R=nearest(n,den,approx);
    if(R<add(writeFirst,ReserveAhead))throw std::runtime_error("reservation lacks future writable lead");
    return LockedReservation{{R,rq,approx,static_cast<double>(dc),rq*static_cast<double>(rdp)/static_cast<double>(rdq)*static_cast<double>(Fs)/static_cast<double>(r1.frequency)},c0,c1,r0,r1,writeFirst,c1.position};
}
inline bool startsInBuffer(std::uint64_t locked,std::uint64_t first,std::uint32_t count,bool alreadySubmitted){
    if(alreadySubmitted)return false;
    if(locked<first)throw std::runtime_error("locked reservation missed; no rescheduling");
    return locked<add(first,count);
}
} // namespace basslab

#pragma once
#include "reservation-policy.hpp"
#include "vendor/json.hpp"
namespace basslab {
using ReservationJson=nlohmann::json;
inline ReservationJson reservationPolicyJson(){return {{"version",ReservationVersion},{"historyWindow100ns",HistoryWindow},{"minimumHistory100ns",HistoryMinimum},{"reservationLeadCaptureFrames",ReserveLead},{"minimumLeadCaptureFrames",ReserveMinimumLead},{"maximumFutureQpc100ns",ReserveMaximumQpc},{"minimumWritableLeadFrames",ReserveAhead},{"actualRenderBufferFrames",441},{"anchorSelection","oldest-distinct-within-window-and-latest"},{"trigger","first-active-render-planning-boundary-at-or-after-E-minus-lead"},{"quantization","nearest-ties-positive"},{"lateAction","stop-no-reschedule"}};}
inline ReservationJson reservationAnchor(const Anchor& a){return {{"id",a.id},{"position",std::to_string(a.position)},{"frequency",std::to_string(a.frequency)},{"qpc100ns",std::to_string(a.qpc)}};}
inline ReservationJson reservationRecord(const LockedReservation& lock,const std::string& run,const std::string& runId,std::size_t index,std::uint64_t E,const std::string& planningId,std::uint32_t bufferFrames){return {{"id",run+"-reservation-"+std::to_string(index)},{"run",run},{"runId",runId},{"scheduleIndex",index},{"policyVersion",ReservationVersion},{"planningId",planningId},{"writeFirstFrame",std::to_string(lock.writeFirst)},{"actualRenderBufferFrames",bufferFrames},{"requestedCaptureFrame",std::to_string(E)},{"renderFrame",std::to_string(lock.prediction.renderFrame)},{"captureAnchorIds",{lock.captureOld.id,lock.captureLatest.id}},{"renderAnchorIds",{lock.renderOld.id,lock.renderLatest.id}},{"captureAnchors",{reservationAnchor(lock.captureOld),reservationAnchor(lock.captureLatest)}},{"renderAnchors",{reservationAnchor(lock.renderOld),reservationAnchor(lock.renderLatest)}},{"unquantizedRenderFrame",lock.prediction.renderApprox},{"quantization","nearest-ties-positive"}};}
inline ReservationJson commitSubmission(const ReservationJson& reservation,std::uint64_t first,std::uint32_t count,const std::string& releaseId,bool releaseSuccessful){
 if(!releaseSuccessful)throw std::runtime_error("submission requires successful release");
 const auto R=decimal(reservation.at("renderFrame").get<std::string>());if(!startsInBuffer(R,first,count,false))throw std::runtime_error("submission outside released buffer");
 const auto i=reservation.at("scheduleIndex").get<std::size_t>();const auto run=reservation.at("run").get<std::string>();
 return {{"id",run+"-"+std::to_string(i)},{"run",run},{"runId",reservation.at("runId")},{"scheduleIndex",i},{"renderFrame",std::to_string(R)},{"bufferFirstFrame",std::to_string(first)},{"bufferFrameCount",count},{"offsetFrames",R-first},{"requestedCaptureFrame",reservation.at("requestedCaptureFrame")},{"releaseId",releaseId},{"releaseSucceeded",true},{"reservationId",reservation.at("id")},{"variant",i%4==0?"accent":"subdiv"}};
}
} // namespace basslab

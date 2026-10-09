#pragma once
#include <algorithm>
#include <array>
#include <filesystem>
#include <cwctype>
#include <cmath>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

namespace basslab::practice {
constexpr std::uint64_t Rate=44100, PreRoll=55125, Tail=88200;
constexpr const char* ScheduleVersion="practice-v13-8-quarter-countin-32-notes-finish-tail2-v1";
constexpr const char* VariableScheduleVersion="practice-v24-8-quarter-countin-task-notes-finish-tail2-v1";
constexpr unsigned CountInClicks=8, MaxPracticeNotes=256;
constexpr const char* CalibrationScheduleVersion="frozen-mulberry32-relative-offset-nearest-ties-up-v1";
constexpr std::array<std::uint64_t,16> CalibrationOffsets={0,33434,70573,104105,137074,173797,211398,246301,280294,314541,351393,386206,419716,452794,489707,527048};
constexpr std::uint64_t CalibrationStopOffset=571149;
struct Click {std::uint64_t offset=0;bool accent=false,countIn=false;std::string kind="practice",variant="subdiv";unsigned noteNumber=0;};
struct Schedule {
    unsigned bpm=60,subdivision=4,plannedNoteCount=0;std::string clickMode="sixteenth";bool calibration=false;
    std::uint64_t practiceBegin=0,practiceEnd=0,captureEnd=0;
    std::vector<Click> clicks;
};
inline std::uint64_t beatFrame(std::uint64_t numerator,unsigned denominator,unsigned bpm) {
    const auto n=numerator*60*Rate,d=static_cast<std::uint64_t>(denominator)*bpm;
    return (n+d/2)/d;
}
inline bool supportedTempo(unsigned bpm) {
    return bpm==40||bpm==50||bpm==60||bpm==70||bpm==80;
}
inline Schedule schedule(unsigned bpm,unsigned subdivision,unsigned plannedNoteCount,const std::string& clickMode="sixteenth") {
    if(!supportedTempo(bpm)||subdivision!=4||(clickMode!="quarter"&&clickMode!="sixteenth"))throw std::runtime_error("unsupported BPM/grid/click mode");
    if(plannedNoteCount<1||plannedNoteCount>MaxPracticeNotes)throw std::runtime_error("planned-note-count-out-of-range");
    Schedule s;s.bpm=bpm;s.subdivision=subdivision;s.plannedNoteCount=plannedNoteCount;s.clickMode=clickMode;
    for(unsigned i=0;i<CountInClicks;++i)s.clicks.push_back({beatFrame(i,1,bpm),false,true,"count-in","subdiv",0});
    const auto lastFour=plannedNoteCount-(std::min)(plannedNoteCount,4u);
    for(unsigned i=0;i<plannedNoteCount;i+=clickMode=="quarter"?4:1)s.clicks.push_back({beatFrame(CountInClicks*subdivision+i,subdivision,bpm),i%subdivision==0,false,"practice",i>=lastFour?"lastbar":i%subdivision==0?"accent":"subdiv",i+1});
    s.practiceBegin=beatFrame(CountInClicks,1,bpm);s.practiceEnd=beatFrame(CountInClicks*subdivision+plannedNoteCount,subdivision,bpm);s.captureEnd=s.practiceEnd+Tail;
    s.clicks.push_back({s.practiceEnd,true,false,"finish","finish",0});
    return s;
}
inline const char* scheduleVersion(const Schedule& s) {
    return s.calibration?CalibrationScheduleVersion:s.plannedNoteCount==32?ScheduleVersion:VariableScheduleVersion;
}
inline Schedule calibrationSchedule() {
    Schedule s;s.bpm=0;s.subdivision=0;s.calibration=true;s.clickMode="calibration";
    for(std::size_t i=0;i<CalibrationOffsets.size();++i)s.clicks.push_back({CalibrationOffsets[i],i%4==0,false,"calibration",i%4==0?"accent":"subdiv",0});
    s.practiceBegin=0;s.practiceEnd=CalibrationOffsets.back();s.captureEnd=CalibrationStopOffset;return s;
}
inline unsigned inputByteOffset(unsigned channel) {
    if(channel!=1&&channel!=2)throw std::runtime_error("input-channel-invalid");
    return (channel-1)*3;
}
inline bool validEndpointId(const std::string& id) {
    if(id.empty()||id.size()>2048)return false;
    return std::all_of(id.begin(),id.end(),[](unsigned char c){return c>=32&&c!=127;});
}
// Lexical boundary check is paired with a no-reparse filesystem walk before I/O.
inline bool containedPath(const std::filesystem::path& root,const std::filesystem::path& child) {
    if(!root.is_absolute()||!child.is_absolute()||root.lexically_normal()!=root||child.lexically_normal()!=child)return false;
    auto lower=[](std::wstring s){for(auto& ch:s)ch=static_cast<wchar_t>(std::towlower(ch));return s;};
    auto r=root.begin(),p=child.begin();
    for(;r!=root.end();++r,++p)if(p==child.end()||lower(r->wstring())!=lower(p->wstring()))return false;
    return true;
}
// QPC projected capture coordinate for visual guidance only. Capture timestamps
// and raw QPC share an epoch; no wall clock is used. Reject stale/future anchors.
// This does not establish physical acoustic arrival or display presentation time.
struct UiProjection {bool valid=false;double seconds=0,ageMs=0;};
inline UiProjection projectCaptureClock(std::uint64_t packetLocalFirst,std::uint64_t packetQpc100ns,std::uint64_t nowRawQpc,std::uint64_t qpcFrequency,std::uint64_t plannedFrames) {
    UiProjection out;
    if(packetQpc100ns==0||qpcFrequency==0)return out;
    const long double now100ns=static_cast<long double>(nowRawQpc)*10000000.0L/qpcFrequency;
    const long double age100ns=now100ns-static_cast<long double>(packetQpc100ns);
    out.ageMs=static_cast<double>(age100ns/10000.0L);
    if(age100ns<0||age100ns>1000000.0L)return out;
    const long double projected=static_cast<long double>(packetLocalFirst)+age100ns*Rate/10000000.0L;
    out.seconds=static_cast<double>((std::min)(projected,static_cast<long double>(plannedFrames))/Rate);
    out.valid=true;return out;
}
inline bool validTakeId(const std::string& id) {
    const auto alnum=[](char c){return(c>='A'&&c<='Z')||(c>='a'&&c<='z')||(c>='0'&&c<='9');};
    if(id.empty()||id.size()>80||!alnum(id[0]))return false;
    for(char c:id)if(!alnum(c)&&c!='_'&&c!='-')return false;
    return true;
}
inline void selection(std::uint64_t first,std::uint64_t end,std::uint64_t length) {
    if(first>=end||end>length)throw std::runtime_error("playback selection outside PCM");
}
inline std::int32_t floatTo24(float f) {
    if(!std::isfinite(f))throw std::runtime_error("non-finite PCM sample");
    const double scaled=static_cast<double>(f)*8388608.0;
    return static_cast<std::int32_t>(std::llround((std::max)(-8388608.0,(std::min)(8388607.0,scaled))));
}
inline void encodeOutput0(unsigned char* frame,float f) {
    const auto n=static_cast<std::uint32_t>(floatTo24(f));
    frame[0]=static_cast<unsigned char>(n&255);frame[1]=static_cast<unsigned char>((n>>8)&255);frame[2]=static_cast<unsigned char>((n>>16)&255);
    frame[3]=frame[4]=frame[5]=0;
}
inline const char* recordPhase(std::uint64_t local,const Schedule& s) {
    if(local<PreRoll)return "preparing";
    if(s.calibration)return local<PreRoll+s.practiceEnd?"calibration":"tail";
    if(local<PreRoll+s.practiceBegin)return "count-in";
    if(local<PreRoll+s.practiceEnd)return "practice";
    return "tail";
}
} // namespace basslab::practice

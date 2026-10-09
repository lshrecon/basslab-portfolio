// Assembly 1. Reuses Stage2RR WASAPI endpoint, format, notification,
// PCM decode, reservation and clock primitives in a separate action lifecycle.
// --serve remains device-dormant until RECORD or PLAY.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <mmdeviceapi.h>
#include <mmreg.h>
#include <functiondiscoverykeys_devpkey.h>
#include <propsys.h>
#include <bcrypt.h>
#include <avrt.h>
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <future>
#include <iomanip>
#include <iostream>
#include <map>
#include <memory>
#include <set>
#include <sstream>
#include <thread>
#include <vector>
#include "vendor/json.hpp"
#include "engine-core.hpp"
#include "reservation-records.hpp"
#include "practice-core.hpp"
#include "guided-paths.hpp"
#include "first-note.hpp"
using json=nlohmann::json;
namespace fs=std::filesystem;
using namespace basslab;
namespace {
fs::path PackageRoot;
const char* Program=basslab::guided::Program;
std::string utc() { SYSTEMTIME t{};GetSystemTime(&t);char b[32]{};sprintf_s(b,"%04u-%02u-%02uT%02u:%02u:%02u.%03uZ",t.wYear,t.wMonth,t.wDay,t.wHour,t.wMinute,t.wSecond,t.wMilliseconds);return b; }
std::string hex32(HRESULT hr) {char b[11]{};sprintf_s(b,"0x%08X",static_cast<unsigned>(hr));return b;}
std::uint64_t ticks() {LARGE_INTEGER t{};if(!QueryPerformanceCounter(&t)||t.QuadPart<0)throw std::runtime_error("QPC read");return static_cast<std::uint64_t>(t.QuadPart);}
std::uint64_t tickFrequency() {LARGE_INTEGER t{};if(!QueryPerformanceFrequency(&t)||t.QuadPart<=0)throw std::runtime_error("QPC frequency");return static_cast<std::uint64_t>(t.QuadPart);}
std::string s(std::uint64_t n) {return std::to_string(n);}
void require(bool okay,const char* reason) {if(!okay)throw std::runtime_error(reason);}
std::wstring widen(const std::string& x) {const int n=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,x.data(),static_cast<int>(x.size()),nullptr,0);require(n>0,"UTF8 path");std::wstring y(static_cast<std::size_t>(n),L'\0');require(MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,x.data(),static_cast<int>(x.size()),y.data(),n)==n,"UTF8 conversion");return y;}
std::string narrow(const std::wstring& x) {if(x.empty())return{};const int n=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,x.data(),static_cast<int>(x.size()),nullptr,0,nullptr,nullptr);require(n>0,"UTF16 path");std::string y(static_cast<std::size_t>(n),'\0');require(WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,x.data(),static_cast<int>(x.size()),y.data(),n,nullptr,nullptr)==n,"UTF16 conversion");return y;}
void plain(const fs::path& p,bool directory) {const DWORD a=GetFileAttributesW(p.c_str());require(a!=INVALID_FILE_ATTRIBUTES,"required path absent");require(!(a&FILE_ATTRIBUTE_REPARSE_POINT),"reparse path forbidden");require(((a&FILE_ATTRIBUTE_DIRECTORY)!=0)==directory,"path kind mismatch");}
void newDirectory(const fs::path& p) {if(!CreateDirectoryW(p.c_str(),nullptr))throw std::runtime_error("directory not new or cannot create: "+narrow(p.wstring()));plain(p,true);}
// Portable take locations are contained in the package and append-only.
// Check without mutation before audio; the writer rechecks before CREATE_NEW.
bool inspectPhysicalTakeDirectory(const fs::path& p) {
    for(auto parent=p.parent_path();!parent.empty();parent=parent.parent_path()){plain(parent,true);if(parent==parent.parent_path())break;}
    const DWORD attributes=GetFileAttributesW(p.c_str());
    if(attributes==INVALID_FILE_ATTRIBUTES){const auto error=GetLastError();require(error==ERROR_FILE_NOT_FOUND||error==ERROR_PATH_NOT_FOUND,"physical take path query failed");return false;}
    require((attributes&FILE_ATTRIBUTE_DIRECTORY)!=0,"physical take path is not a directory");
    require((attributes&FILE_ATTRIBUTE_REPARSE_POINT)==0,"physical take reparse point forbidden");
    std::error_code error;const fs::directory_iterator first(p,fs::directory_options::none,error);
    require(!error,"physical take directory enumeration failed");require(first==fs::directory_iterator{},"physical take directory is not empty");
    plain(p,true);return true;
}
void preparePhysicalTakeDirectory(const fs::path& p) {
    if(!inspectPhysicalTakeDirectory(p))newDirectory(p);
    require(inspectPhysicalTakeDirectory(p),"physical take directory preparation failed");
}
void portablePath(const fs::path& p) {
    require(basslab::practice::containedPath(PackageRoot,p),"path-outside-package");
    for(auto parent=p.parent_path();!parent.empty();parent=parent.parent_path()){plain(parent,true);if(parent==parent.parent_path())break;}
}
fs::path executablePath(){std::vector<wchar_t> name(32768);const auto n=GetModuleFileNameW(nullptr,name.data(),static_cast<DWORD>(name.size()));require(n>0&&n<name.size(),"self path");return fs::path(std::wstring(name.data(),n)).lexically_normal();}
void initializePackageRoot(){
    const auto exe=executablePath();require(exe.parent_path().filename()==L"bin"&&exe.parent_path().parent_path().filename()==L"native","engine-location-invalid");
    PackageRoot=exe.parent_path().parent_path().parent_path();require(PackageRoot.is_absolute(),"package-root-not-absolute");plain(PackageRoot,true);
}
class File {
    HANDLE h_=INVALID_HANDLE_VALUE;
public:
    File()=default;File(const File&)=delete;File& operator=(const File&)=delete;
    ~File(){if(h_!=INVALID_HANDLE_VALUE)CloseHandle(h_);}
    void open(const fs::path& p) {require(h_==INVALID_HANDLE_VALUE,"file already open");h_=CreateFileW(p.c_str(),GENERIC_WRITE,FILE_SHARE_READ,nullptr,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,nullptr);require(h_!=INVALID_HANDLE_VALUE,"CREATE_NEW failed");}
    void write(const void* p,std::size_t n) {require(h_!=INVALID_HANDLE_VALUE&&n<=MAXDWORD,"file write range");DWORD w=0;require(WriteFile(h_,p,static_cast<DWORD>(n),&w,nullptr)&&w==n,"file write failed");}
    void line(const json& j) {const auto t=j.dump()+"\n";write(t.data(),t.size());}
    void flush(){if(h_!=INVALID_HANDLE_VALUE)require(FlushFileBuffers(h_)!=FALSE,"file flush failed");}
    void close(){if(h_!=INVALID_HANDLE_VALUE){flush();HANDLE p=h_;h_=INVALID_HANDLE_VALUE;require(CloseHandle(p)!=FALSE,"file close failed");}}
};
struct Hash {
    BCRYPT_ALG_HANDLE alg=nullptr;BCRYPT_HASH_HANDLE hash=nullptr;std::vector<unsigned char> object;
    explicit Hash(bool reusable=false){require(BCryptOpenAlgorithmProvider(&alg,BCRYPT_SHA256_ALGORITHM,nullptr,0)>=0,"SHA provider");ULONG n=0,len=0;require(BCryptGetProperty(alg,BCRYPT_OBJECT_LENGTH,reinterpret_cast<PUCHAR>(&len),sizeof(len),&n,0)>=0,"SHA property");object.resize(len);require(BCryptCreateHash(alg,&hash,object.data(),len,nullptr,0,reusable?BCRYPT_HASH_REUSABLE_FLAG:0)>=0,"SHA initialize");}
    ~Hash(){if(hash)BCryptDestroyHash(hash);if(alg)BCryptCloseAlgorithmProvider(alg,0);}
    void update(const void* p,std::size_t n){require(n<=static_cast<std::size_t>(ULONG_MAX),"SHA length");require(BCryptHashData(hash,const_cast<PUCHAR>(static_cast<const unsigned char*>(p)),static_cast<ULONG>(n),0)>=0,"SHA data");}
    std::string finish(){unsigned char out[32]{};require(BCryptFinishHash(hash,out,32,0)>=0,"SHA finish");std::ostringstream text;text<<std::hex<<std::setfill('0');for(auto x:out)text<<std::setw(2)<<static_cast<unsigned>(x);return text.str();}
};
std::string digest(const void* p,std::size_t n){Hash h;h.update(p,n);return h.finish();}
std::vector<unsigned char> read(const fs::path& p){portablePath(p);plain(p,false);std::ifstream f(p,std::ios::binary);require(f.good(),"input read");std::vector<unsigned char> out{std::istreambuf_iterator<char>(f),{}};require(!f.bad(),"input read failed");return out;}
class Input {
    std::thread thread_;std::atomic<bool> ending_{false};std::unique_ptr<Spsc<json,128>> commands_=std::make_unique<Spsc<json,128>>();
public:
    std::atomic<bool> failed{false};std::string error;
    Input(){thread_=std::thread([this]{try{const HANDLE input=GetStdHandle(STD_INPUT_HANDLE);require(input&&input!=INVALID_HANDLE_VALUE,"stdin handle");std::string line;char block[1024];while(!ending_.load()){DWORD n=0;const BOOL okay=ReadFile(input,block,sizeof(block),&n,nullptr);if(!okay||!n){if(ending_.load())return;throw std::runtime_error("stdin EOF/read error");}for(DWORD i=0;i<n;++i){if(block[i]=='\n'){if(!line.empty()&&line.back()=='\r')line.pop_back();require(!line.empty(),"empty IPC command");auto j=json::parse(line);require(commands_->push(std::move(j)),"IPC queue overflow");line.clear();}else{line+=block[i];require(line.size()<=8192,"IPC line too long");}}}}catch(const std::exception& ex){error=ex.what();failed.store(true,std::memory_order_release);}});}
    ~Input(){ending_.store(true);if(thread_.joinable()){CancelSynchronousIo(thread_.native_handle());thread_.join();}}
    bool pop(json& j){return commands_->pop(j);}
};
template<class T> struct Com {T* p=nullptr;~Com(){if(p)p->Release();}T** put(){require(!p,"COM overwrite");return &p;}T* operator->()const{return p;}};
struct Notice {std::atomic<bool> ready{false};unsigned type=0,value=0;std::uint64_t qpc=0;bool duringStream=false;wchar_t text[256]{};};
class Notifications final: public IMMNotificationClient,public IAudioSessionEvents {
    std::atomic<ULONG> refs_{1};std::atomic<unsigned> written_{0};unsigned consumed_=0;std::array<Notice,512> notices_;
    HRESULT emit(unsigned type,unsigned value,LPCWSTR id){const auto i=written_.fetch_add(1);if(i>=notices_.size()){overflow.store(true);return S_OK;}auto& n=notices_[i];n.type=type;n.value=value;n.duringStream=streamsStarted.load();LARGE_INTEGER q{};n.qpc=QueryPerformanceCounter(&q)&&q.QuadPart>=0?static_cast<std::uint64_t>(q.QuadPart):0;if(id)wcsncpy_s(n.text,id,_TRUNCATE);n.ready.store(true,std::memory_order_release);return S_OK;}
public:
    std::atomic<bool> overflow{false},streamsStarted{false};
    bool next(unsigned& type,unsigned& value,std::uint64_t& qpc,std::wstring& text,bool& duringStream){if(consumed_>=notices_.size())return false;auto& n=notices_[consumed_];if(!n.ready.load(std::memory_order_acquire))return false;type=n.type;value=n.value;qpc=n.qpc;text=n.text;duringStream=n.duringStream;++consumed_;return true;}
    ULONG STDMETHODCALLTYPE AddRef()override{return ++refs_;}ULONG STDMETHODCALLTYPE Release()override{const auto n=--refs_;if(!n)delete this;return n;}
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid,void** out)override{if(!out)return E_POINTER;*out=nullptr;if(iid==__uuidof(IUnknown)||iid==__uuidof(IMMNotificationClient))*out=static_cast<IMMNotificationClient*>(this);else if(iid==__uuidof(IAudioSessionEvents))*out=static_cast<IAudioSessionEvents*>(this);else return E_NOINTERFACE;AddRef();return S_OK;}
    HRESULT STDMETHODCALLTYPE OnDeviceStateChanged(LPCWSTR id,DWORD state)override{return emit(1,state,id);}
    HRESULT STDMETHODCALLTYPE OnDeviceAdded(LPCWSTR id)override{return emit(2,0,id);}
    HRESULT STDMETHODCALLTYPE OnDeviceRemoved(LPCWSTR id)override{return emit(3,0,id);}
    HRESULT STDMETHODCALLTYPE OnDefaultDeviceChanged(EDataFlow flow,ERole role,LPCWSTR id)override{return emit(4,static_cast<unsigned>(flow)*10+static_cast<unsigned>(role),id);}
    HRESULT STDMETHODCALLTYPE OnPropertyValueChanged(LPCWSTR id,const PROPERTYKEY)override{return emit(5,0,id);}
    HRESULT STDMETHODCALLTYPE OnDisplayNameChanged(LPCWSTR name,LPCGUID)override{return emit(6,0,name);}
    HRESULT STDMETHODCALLTYPE OnIconPathChanged(LPCWSTR path,LPCGUID)override{return emit(7,0,path);}
    HRESULT STDMETHODCALLTYPE OnSimpleVolumeChanged(float volume,BOOL mute,LPCGUID)override{std::uint32_t bits=0;std::memcpy(&bits,&volume,4);return emit(8,bits,mute?L"muted":L"unmuted");}
    HRESULT STDMETHODCALLTYPE OnChannelVolumeChanged(DWORD count,float[],DWORD index,LPCGUID)override{return emit(9,index,(L"channels="+std::to_wstring(count)).c_str());}
    HRESULT STDMETHODCALLTYPE OnGroupingParamChanged(LPCGUID,LPCGUID)override{return emit(10,0,nullptr);}
    HRESULT STDMETHODCALLTYPE OnStateChanged(AudioSessionState state)override{return emit(11,static_cast<unsigned>(state),nullptr);}
    HRESULT STDMETHODCALLTYPE OnSessionDisconnected(AudioSessionDisconnectReason reason)override{return emit(12,static_cast<unsigned>(reason),nullptr);}
};
WAVEFORMATEXTENSIBLE wave(){WAVEFORMATEXTENSIBLE w{};w.Format.wFormatTag=WAVE_FORMAT_EXTENSIBLE;w.Format.nChannels=2;w.Format.nSamplesPerSec=44100;w.Format.nAvgBytesPerSec=264600;w.Format.nBlockAlign=6;w.Format.wBitsPerSample=24;w.Format.cbSize=22;w.Samples.wValidBitsPerSample=24;w.dwChannelMask=3;w.SubFormat={1,0,0x0010,{0x80,0,0,0xaa,0,0x38,0x9b,0x71}};return w;}
struct Endpoint {Com<IMMDevice> device;Com<IAudioClient> client;Com<IAudioClock> clock;Com<IAudioSessionControl> control;HANDLE event=nullptr;UINT32 frames=0;UINT64 frequency=0;bool started=false,registered=false;~Endpoint(){if(event)CloseHandle(event);}};
namespace practice=basslab::practice;
std::string errorCode(const std::string& reason){
    for(const auto* code:{"format-unsupported","device-in-use","device-unavailable","exclusive-mode-disabled","buffer-size-unsupported","input-channel-invalid","device-selection-required","device-selection-invalid","path-outside-package"})if(reason.find(code)!=std::string::npos)return code;
    return "native-error";
}
void emit(json value){if(value.value("event","")=="ERROR"&&!value.contains("errorCode"))value["errorCode"]=errorCode(value.value("reason",value.value("message","")));value["utc"]=utc();std::cout<<value.dump()<<std::endl;require(std::cout.good(),"stdout pipe failure");}
void enumerateDevices(){
    // This path never activates an audio client, opens a stream or selects a default.
    const auto hr=CoInitializeEx(nullptr,COINIT_MULTITHREADED);require(hr==S_OK||hr==S_FALSE,"COM enumerate initialize");
    struct Apartment{~Apartment(){CoUninitialize();}} apartment;
    Com<IMMDeviceEnumerator> enumerator;require(CoCreateInstance(__uuidof(MMDeviceEnumerator),nullptr,CLSCTX_ALL,__uuidof(IMMDeviceEnumerator),reinterpret_cast<void**>(enumerator.put()))==S_OK,"device-list-unavailable");
    json value={{"event","DEVICES"},{"render",json::array()},{"capture",json::array()},{"deviceStreamOpens",0},{"audioClientActivations",0}};
    for(const auto flow:{eRender,eCapture}){
        Com<IMMDeviceCollection> devices;require(enumerator->EnumAudioEndpoints(flow,DEVICE_STATE_ACTIVE,devices.put())==S_OK,"device-list-unavailable");
        UINT count=0;require(devices->GetCount(&count)==S_OK,"device-list-unavailable");
        for(UINT i=0;i<count;++i){
            Com<IMMDevice> device;require(devices->Item(i,device.put())==S_OK,"device-list-unavailable");LPWSTR rawId=nullptr;
            require(device->GetId(&rawId)==S_OK&&rawId,"device-list-unavailable");std::wstring id=rawId;CoTaskMemFree(rawId);
            Com<IPropertyStore> props;require(device->OpenPropertyStore(STGM_READ,props.put())==S_OK,"device-list-unavailable");
            PROPVARIANT prop;PropVariantInit(&prop);const auto result=props->GetValue(PKEY_Device_FriendlyName,&prop);
            std::wstring name;if(result==S_OK&&prop.vt==VT_LPWSTR&&prop.pwszVal)name=prop.pwszVal;PropVariantClear(&prop);
            require(!name.empty(),"device-name-unavailable");value[flow==eRender?"render":"capture"].push_back({{"id",narrow(id)},{"name",narrow(name)},{"active",true}});
        }
    }
    emit(std::move(value));
}
std::uint64_t integer(const json& value){
    require(value.is_number_unsigned()||(value.is_number_integer()&&value.get<std::int64_t>()>=0),"nonnegative integer required");
    const auto n=value.get<std::uint64_t>();require(n<=9007199254740991ULL,"integer exceeds safe JSON range");return n;
}
unsigned requestPlannedNoteCount(const json& payload){
    const auto count=integer(payload.at("plannedNoteCount"));
    require(count>=1&&count<=practice::MaxPracticeNotes,"planned-note-count-out-of-range");
    return static_cast<unsigned>(count);
}
std::string requestParticipant(const json& payload){
    if(!payload.contains("participant"))return u8"나";
    require(payload.at("participant").is_string(),"participant-invalid");
    const auto label=payload.at("participant").get<std::string>();
    require(!label.empty()&&label.size()<=120&&std::all_of(label.begin(),label.end(),[](unsigned char c){return c>=32&&c!=127;}),"participant-invalid");
    (void)widen(label); // Validate UTF-8; NFC/trim normalization belongs to the bridge.
    return label;
}
json practiceLocalBoundaries(const practice::Schedule& schedule){
    return {{"preparingStart",0},{"countInStart",practice::PreRoll},{"practiceStart",practice::PreRoll+schedule.practiceBegin},{"practiceEnd",practice::PreRoll+schedule.practiceEnd},{"captureEnd",practice::PreRoll+schedule.captureEnd}};
}
struct Resources {
    std::vector<unsigned char> accent,subdiv,lastbar,finish;
    explicit Resources(const fs::path& root){
        require(root==PackageRoot/L"resources","resources root mismatch");plain(root,true);
        accent=read(root/L"accent.pcm24-stereo.bin");subdiv=read(root/L"subdivision.pcm24-stereo.bin");lastbar=read(root/L"lastbar.pcm24-stereo.bin");finish=read(root/L"finish.pcm24-stereo.bin");
        require(accent.size()==13230&&digest(accent.data(),accent.size())=="089c69a4a378bb2c4bcece35ac760d5c8e4f54149d62ba9d4c2790d481370328","accent identity mismatch");
        require(subdiv.size()==13230&&digest(subdiv.data(),subdiv.size())=="febda695eb547539a1484dbfc690523efbc864e82b67124678fa9844361d6e53","subdivision identity mismatch");
        require(lastbar.size()==13230&&digest(lastbar.data(),lastbar.size())=="a89c017c41606a348a18f4c20acd5153fc8c5d610fb978eb8a090a5aa3567e7f","lastbar identity mismatch");
        require(finish.size()==13230&&digest(finish.data(),finish.size())=="ac9f68bc751e2a78632fbc41aa90f3cd8f67422632efa3bafc54b3c7e1b7352c","finish identity mismatch");
        for(const auto* data:{&accent,&subdiv,&lastbar,&finish})for(std::size_t i=0;i<2205;++i)require((*data)[i*6+3]==0&&(*data)[i*6+4]==0&&(*data)[i*6+5]==0,"output1 must be silent");
    }
    const std::vector<unsigned char>& at(const std::string& variant)const{if(variant=="accent")return accent;if(variant=="subdiv")return subdiv;if(variant=="lastbar")return lastbar;if(variant=="finish")return finish;throw std::runtime_error("resource-variant-invalid");}
};
struct WriteJob {std::string target;json row;std::vector<float> pcm;};
class CaptureWriter {
    fs::path take_,ledger_;std::unique_ptr<Spsc<WriteJob,2048>> queue_=std::make_unique<Spsc<WriteJob,2048>>();
    std::thread worker_;HANDLE wake_=nullptr;std::atomic<bool> done_{false},ready_{false};
public:
    std::atomic<bool> failed{false};std::string error;
    CaptureWriter(fs::path take,fs::path ledger):take_(std::move(take)),ledger_(std::move(ledger)){
        wake_=CreateEventW(nullptr,FALSE,FALSE,nullptr);require(wake_!=nullptr,"writer event creation");
        worker_=std::thread([this]{run();});while(!ready_.load()&&!failed.load())Sleep(1);
        if(failed.load()){stop();CloseHandle(wake_);wake_=nullptr;throw std::runtime_error(error);}
    }
    ~CaptureWriter(){stop();if(wake_)CloseHandle(wake_);}
    void push(WriteJob job){require(!failed.load(std::memory_order_acquire),"writer failed");require(queue_->push(std::move(job)),"writer queue overflow");SetEvent(wake_);}
    void stop(){done_.store(true);if(wake_)SetEvent(wake_);if(worker_.joinable())worker_.join();}
private:
    void run(){try{
        File pcm;pcm.open(take_/L"pcm.f32le");std::map<std::string,std::unique_ptr<File>> logs;
        for(const auto* name:{"events","clock","packets","reservations","submissions","render-buffers"}){auto f=std::make_unique<File>();f->open(ledger_/(std::string(name)+".jsonl"));logs.emplace(name,std::move(f));}
        ready_.store(true,std::memory_order_release);
        for(;;){WriteJob job;if(!queue_->pop(job)){if(done_.load())break;WaitForSingleObject(wake_,100);continue;}
            if(job.target=="pcm")pcm.write(job.pcm.data(),job.pcm.size()*sizeof(float));else logs.at(job.target)->line(job.row);
        }
        pcm.close();for(auto& pair:logs)pair.second->close();
    }catch(const std::exception& ex){error=ex.what();failed.store(true,std::memory_order_release);}}
};
struct Command {std::string id,name;json payload;};
class Commands {
    Input input_;std::set<std::string> ids_;
public:
    bool failed()const{return input_.failed.load(std::memory_order_acquire);}
    bool next(Command& out){
        json row;if(!input_.pop(row)){if(failed())throw std::runtime_error(input_.error);return false;}
        require(row.is_object()&&row.contains("id")&&row.contains("command"),"command schema");
        out.id=row.at("id").get<std::string>();out.name=row.at("command").get<std::string>();
        require(!out.id.empty()&&out.id.size()<=128&&ids_.size()<100000&&ids_.insert(out.id).second,"duplicate/invalid command id");
        out.payload=row.value("payload",json::object());require(out.payload.is_object(),"command payload must be object");
        if(failed()&&out.name!="END"&&out.name!="STOP")throw std::runtime_error(input_.error);return true;
    }
};
json identity(const fs::path& path){const auto bytes=read(path);return{{"path",narrow(path.wstring())},{"bytes",bytes.size()},{"sha256",digest(bytes.data(),bytes.size())}};}
json engineIdentities(){
    std::vector<wchar_t> name(32768);const auto n=GetModuleFileNameW(nullptr,name.data(),static_cast<DWORD>(name.size()));require(n>0&&n<name.size(),"self path");
    const auto native=PackageRoot/L"native";
    const auto resources=PackageRoot/L"resources";
    return{{"executable",identity(fs::path(std::wstring(name.data(),n)))},{"engineSource",identity(native/L"practice-engine.cpp")},{"practiceCore",identity(native/L"practice-core.hpp")},{"firstNoteTracker",identity(native/L"first-note.hpp")},{"guidancePaths",identity(native/L"guided-paths.hpp")},{"reservationPolicy",identity(native/L"reservation-policy.hpp")},{"engineCore",identity(native/L"engine-core.hpp")},{"reservationRecords",identity(native/L"reservation-records.hpp")},{"jsonHeader",identity(native/L"vendor"/L"json.hpp")},{"accentResource",identity(resources/L"accent.pcm24-stereo.bin")},{"subdivisionResource",identity(resources/L"subdivision.pcm24-stereo.bin")},{"lastbarResource",identity(resources/L"lastbar.pcm24-stereo.bin")},{"finishResource",identity(resources/L"finish.pcm24-stereo.bin")}};
}
class Action {
    const fs::path root_;fs::path takePath_,ledgerPath_;const Resources& resources_;const json& identities_;Commands& commands_;
    bool record_=false,preview_=false,calibration_=false,co_=false,registered_=false,stop_=false,end_=false,normalComplete_=false,released_=true,sourceBegun_=false;
    std::wstring renderId_,captureId_;unsigned inputChannel_=0;json deviceSelection_,clickCalibration_;
    firstnote::Tracker firstNoteTracker_;std::future<firstnote::Estimate> firstNotePending_;std::uint64_t lastFirstNote_=0;std::string taskId_,monitorRoute_,clickMode_,participant_;
    std::string takeId_,commandId_,operation_,startedAt_,finishedAt_,failure_,stopCommandId_;unsigned ordinal_=0;
    practice::Schedule schedule_;std::uint64_t first_=0,firstClick_=0,captureEnd_=0,captureNow_=0,stored_=0,submittedFrames_=0,playFirst_=0,playEnd_=0,playSubmitted_=0,playConsumed_=0;
    std::uint64_t sequence_=0,qpf_=tickFrequency(),lastStatus_=0,lastClockAdvance_=0,lastClockPosition_=0;unsigned initializeCalls_=0,startCalls_=0;
    std::uint64_t latestCaptureLocalFirst_=0,latestCaptureQpc100ns_=0,statusSequence_=0;double lastUiSeconds_=0;
    std::vector<float> playback_;std::vector<std::optional<std::uint64_t>> clickFrames_;std::vector<bool> clickSubmitted_;std::vector<std::uint64_t> clickBytes_;std::vector<json> reservations_;
    std::unique_ptr<CaptureWriter> writer_;std::vector<json> memoryEvents_;double peak_=0,squares_=0;std::uint64_t clipped_=0;
    Com<IMMDeviceEnumerator> enumerator_;Endpoint render_,capture_;Com<IAudioRenderClient> renderer_;Com<IAudioCaptureClient> capturer_;Notifications* notices_=nullptr;HANDLE mmcss_=nullptr;DWORD taskIndex_=0;
    ReservationHistory renderHistory_,captureHistory_;Continuity continuity_;Hash renderHasher_{true};
public:
    Action(const Command& command,fs::path root,const fs::path& runtime,const Resources& resources,const json& identities,Commands& commands,unsigned ordinal)
        :root_(std::move(root)),resources_(resources),identities_(identities),commands_(commands),record_(command.name=="RECORD"||command.name=="FIRST_NOTE"||command.name=="CALIBRATE"),preview_(command.name=="FIRST_NOTE"),calibration_(command.name=="CALIBRATE"),takeId_(command.payload.at("takeId").get<std::string>()),commandId_(command.id),operation_(preview_?"first-note":calibration_?"calibration":record_?"record":"play"),ordinal_(ordinal){
        require(practice::validTakeId(takeId_),"invalid take id");
        participant_=requestParticipant(command.payload);
        deviceSelection_=command.payload.at("deviceSelection");require(deviceSelection_.is_object(),"device-selection-required");
        const auto render=deviceSelection_.at("renderId").get<std::string>(),capture=deviceSelection_.at("captureId").get<std::string>();
        require(practice::validEndpointId(render)&&practice::validEndpointId(capture),"device-selection-invalid");
        renderId_=widen(render);captureId_=widen(capture);const auto channel=integer(deviceSelection_.at("inputChannel"));require(channel==1||channel==2,"input-channel-invalid");inputChannel_=static_cast<unsigned>(channel);
        clickCalibration_=command.payload.value("clickCalibration",json(nullptr));
        if(!clickCalibration_.is_null()){require(clickCalibration_.is_object(),"click-calibration-invalid");const auto k=integer(clickCalibration_.at("kFrames"));require(k<=Fs/2,"click-calibration-range");require(!clickCalibration_.contains("validatedForThisEngine")||clickCalibration_["validatedForThisEngine"].is_boolean(),"click-calibration-invalid");}
        takePath_=(calibration_?PackageRoot/L"calibrations":root_)/takeId_;portablePath(takePath_);ledgerPath_=runtime/("action-"+s(ordinal_));
        portablePath(ledgerPath_);
        if(record_){
            if(calibration_){schedule_=practice::calibrationSchedule();taskId_="calibration";monitorRoute_="loopback";clickMode_="calibration";}
            else{
            const auto bpm=integer(command.payload.at("bpm")),grid=integer(command.payload.at("subdivision"));require(bpm<=80&&practice::supportedTempo(static_cast<unsigned>(bpm))&&grid==4,"unsupported BPM/grid");
            taskId_=command.payload.at("taskId").get<std::string>();require(practice::validTakeId(taskId_),"invalid task id");
            monitorRoute_=command.payload.at("monitorRoute").get<std::string>();require(monitorRoute_=="unknown"||monitorRoute_=="direct"||monitorRoute_=="software","invalid monitoring route");
            clickMode_=command.payload.at("clickMode").get<std::string>();
            schedule_=practice::schedule(static_cast<unsigned>(bpm),static_cast<unsigned>(grid),requestPlannedNoteCount(command.payload),clickMode_);
            }
            if(preview_){schedule_.clicks.clear();schedule_.captureEnd=30*Fs-practice::PreRoll;}
            const auto size=schedule_.clicks.size();clickFrames_.resize(size);clickSubmitted_.resize(size,false);clickBytes_.resize(size,0);reservations_.resize(size);
            newDirectory(ledgerPath_);
            if(!preview_){require(!inspectPhysicalTakeDirectory(takePath_),"take directory already exists");preparePhysicalTakeDirectory(takePath_);writer_=std::make_unique<CaptureWriter>(takePath_,ledgerPath_);}
        }else{
            plain(takePath_,true);const auto runBytes=read(takePath_/L"run.json");const auto meta=json::parse(runBytes);
            require(meta.at("schema")==basslab::guided::RunSchema&&meta.at("takeId")==takeId_,"take metadata identity");const auto& pcm=meta.at("pcm");
            require(pcm.at("sampleRate")==44100&&pcm.at("channels")==1&&pcm.at("encoding")=="f32le","PCM format mismatch");
            const auto bytes=read(takePath_/L"pcm.f32le");require(!bytes.empty()&&bytes.size()<=64*1024*1024&&bytes.size()%4==0,"PCM length invalid");
            require(integer(pcm.at("frameCount"))==bytes.size()/4&&integer(pcm.at("byteLength"))==bytes.size(),"PCM metadata length mismatch");
            require(digest(bytes.data(),bytes.size())==pcm.at("sha256"),"PCM identity mismatch");
            playback_.resize(bytes.size()/4);std::memcpy(playback_.data(),bytes.data(),bytes.size());for(float f:playback_)require(std::isfinite(f)&&f>=-1&&f<=1,"invalid PCM sample");
            playFirst_=integer(command.payload.at("startFrame"));playEnd_=integer(command.payload.at("endFrame"));practice::selection(playFirst_,playEnd_,playback_.size());newDirectory(ledgerPath_);
        }
    }
    ~Action(){cleanup();}
    bool endRequested()const{return end_;}bool deviceReleased()const{return released_;}
    void execute(){
        startedAt_=utc();lastStatus_=ticks();lastClockAdvance_=lastStatus_;
        try{log("events",{{"event","ACTION_BEGIN"},{"operation",operation_},{"commandId",commandId_}});prepare();start();loop();drainNotices(true);}
        catch(const std::exception& ex){failure_=ex.what();}
        cleanup();finishedAt_=utc();
        if(!failure_.empty())emit({{"event","ERROR"},{"takeId",takeId_},{"operation",operation_},{"message",failure_},{"reason",failure_},{"commandId",commandId_},{"recoverable",released_&&!commands_.failed()},{"deviceReleased",released_}});
        if(record_&&!preview_){try{saveTake();}catch(const std::exception& ex){emit({{"event","ERROR"},{"takeId",takeId_},{"operation",operation_},{"message",std::string("save failed: ")+ex.what()},{"recoverable",released_},{"deviceReleased",released_}});}}
        else {File ledger;ledger.open(ledgerPath_/L"events.jsonl");for(const auto& row:memoryEvents_)ledger.line(row);ledger.close();}
        if(stop_)emit({{"event","STOPPED"},{"operation",operation_},{"takeId",takeId_},{"commandId",stopCommandId_},{"deviceReleased",released_}});
        if(preview_)emit({{"event","FIRST_NOTE_DONE"},{"operation",operation_},{"taskId",taskId_},{"takeId",takeId_},{"deviceReleased",released_},{"savedPcm",false},{"memoryOnly",true},{"timeout",normalComplete_}});
        else if(!record_&&normalComplete_&&failure_.empty())emit({{"event","PLAYBACK_DONE"},{"takeId",takeId_},{"commandId",commandId_},{"startFrame",playFirst_},{"endFrame",playEnd_},{"consumedFrameCount",playConsumed_},{"deviceReleased",released_}});
    }
private:
    void log(const std::string& target,json row){row["sequence"]=++sequence_;row["ledger"]=target;row["utc"]=utc();row["rawQpcTicks"]=s(ticks());row["rawQpcFrequency"]=s(qpf_);row["takeId"]=takeId_;row["operation"]=operation_;if(writer_)writer_->push({target,std::move(row),{}});else memoryEvents_.push_back(std::move(row));}
    void api(const char* name,HRESULT hr,const char* endpoint){log("events",{{"event","API"},{"api",name},{"endpoint",endpoint},{"hresult",hex32(hr)}});if(hr!=S_OK){const char* code=hr==AUDCLNT_E_UNSUPPORTED_FORMAT?"format-unsupported":hr==AUDCLNT_E_DEVICE_IN_USE?"device-in-use":hr==AUDCLNT_E_DEVICE_INVALIDATED?"device-unavailable":hr==AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED?"exclusive-mode-disabled":std::string(name)=="GetDevice"?"device-unavailable":"native-error";throw std::runtime_error(std::string(code)+" "+name+" "+hex32(hr));}}
    void prepare(){
        const auto hr=CoInitializeEx(nullptr,COINIT_MULTITHREADED);require(hr==S_OK||hr==S_FALSE,"COM initialize");co_=true;
        api("CoCreateInstance",CoCreateInstance(__uuidof(MMDeviceEnumerator),nullptr,CLSCTX_ALL,__uuidof(IMMDeviceEnumerator),reinterpret_cast<void**>(enumerator_.put())),"both");
        notices_=new Notifications;api("RegisterEndpointNotificationCallback",enumerator_->RegisterEndpointNotificationCallback(notices_),"both");registered_=true;
        prepareEndpoint(render_,renderId_.c_str(),eRender,"render");if(record_)prepareEndpoint(capture_,captureId_.c_str(),eCapture,"capture");
        api("GetService(IAudioRenderClient)",render_.client->GetService(__uuidof(IAudioRenderClient),reinterpret_cast<void**>(renderer_.put())),"render");
        if(record_)api("GetService(IAudioCaptureClient)",capture_.client->GetService(__uuidof(IAudioCaptureClient),reinterpret_cast<void**>(capturer_.put())),"capture");
        mmcss_=AvSetMmThreadCharacteristicsW(L"Pro Audio",&taskIndex_);require(mmcss_!=nullptr,"MMCSS registration failed");
    }
    void prepareEndpoint(Endpoint& e,LPCWSTR id,EDataFlow expected,const char* label){
        api("GetDevice",enumerator_->GetDevice(id,e.device.put()),label);DWORD state=0;api("GetState",e.device->GetState(&state),label);require(state==DEVICE_STATE_ACTIVE,"device-unavailable endpoint not active");
        LPWSTR actual=nullptr;api("GetId",e.device->GetId(&actual),label);const bool same=actual&&std::wstring(actual)==id;CoTaskMemFree(actual);require(same,"endpoint identity changed");
        Com<IMMEndpoint> endpoint;api("QueryInterface",e.device->QueryInterface(__uuidof(IMMEndpoint),reinterpret_cast<void**>(endpoint.put())),label);EDataFlow flow=eAll;api("GetDataFlow",endpoint->GetDataFlow(&flow),label);require(flow==expected,"endpoint direction changed");
        api("Activate",e.device->Activate(__uuidof(IAudioClient),CLSCTX_ALL,nullptr,reinterpret_cast<void**>(e.client.put())),label);released_=false;
        e.event=CreateEventW(nullptr,FALSE,FALSE,nullptr);require(e.event!=nullptr,"audio event creation");auto format=wave();++initializeCalls_;
        api("Initialize",e.client->Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE,AUDCLNT_STREAMFLAGS_EVENTCALLBACK,100000,100000,&format.Format,nullptr),label);
        api("SetEventHandle",e.client->SetEventHandle(e.event),label);api("GetBufferSize",e.client->GetBufferSize(&e.frames),label);require(e.frames==441,"buffer-size-unsupported requires 441 frames");
        api("GetService(IAudioClock)",e.client->GetService(__uuidof(IAudioClock),reinterpret_cast<void**>(e.clock.put())),label);api("GetFrequency",e.clock->GetFrequency(&e.frequency),label);require(e.frequency!=0,"zero clock frequency");
        api("GetService(IAudioSessionControl)",e.client->GetService(__uuidof(IAudioSessionControl),reinterpret_cast<void**>(e.control.put())),label);api("RegisterAudioSessionNotification",e.control->RegisterAudioSessionNotification(notices_),label);e.registered=true;
        log("events",{{"event","ENDPOINT_PREPARED"},{"endpoint",label},{"endpointId",narrow(id)},{"sampleRate",44100},{"channels",2},{"containerBits",24},{"validBits",24},{"bufferFrames",e.frames},{"shareMode","exclusive"}});
    }
    void start(){
        notices_->streamsStarted.store(true);if(record_){++startCalls_;const auto hr=capture_.client->Start();capture_.started=hr==S_OK;api("Start",hr,"capture");}
        renderBuffer(true);++startCalls_;const auto hr=render_.client->Start();render_.started=hr==S_OK;api("Start",hr,"render");
        emit({{"event",preview_?"FIRST_NOTE_STARTED":record_?"RECORDING":"PLAYING"},{"operation",operation_},{"takeId",takeId_},{"commandId",commandId_},{"phase",preview_?"first-note":record_?"preparing":"playback"},{"deviceReleased",false},{"plannedClickCount",record_?schedule_.clicks.size():0},{"startFrame",record_?0:playFirst_},{"endFrame",record_?0:playEnd_}});
    }
    void drainNotices(bool mayThrow){
        if(!notices_)return;unsigned type=0,value=0;std::uint64_t q=0;std::wstring text;bool during=false;
        while(notices_->next(type,value,q,text,during)){
            const bool selected=text==renderId_.c_str()||(record_&&text==captureId_.c_str());
            const bool invalid=type==12||(during&&((selected&&(type==1||type==3||type==5))||type==8||type==9||(type==11&&value!=AudioSessionStateActive)));
            try{log("events",{{"event","DEVICE_OR_SESSION_NOTIFICATION"},{"type",type},{"value",value},{"text",narrow(text)},{"eventRawQpcTicks",q?json(s(q)):json(nullptr)},{"timestampUnknown",q==0},{"duringStreamAtCallback",during},{"invalidating",invalid}});}catch(...){if(mayThrow)throw;}
            if(invalid){if(failure_.empty())failure_="device/session invalidation";if(mayThrow)throw std::runtime_error(failure_);}
        }
        if(notices_->overflow.load()){if(failure_.empty())failure_="notification queue overflow";if(mayThrow)throw std::runtime_error(failure_);}
    }
    void cleanup()noexcept{
        if(!co_&&!enumerator_.p&&!notices_)return;
        if(notices_)notices_->streamsStarted.store(false);
        const auto quiet=[this](const char* name,HRESULT hr,const char* endpoint){try{log("events",{{"event",name},{"endpoint",endpoint},{"hresult",hex32(hr)}});}catch(...){}if(hr!=S_OK&&failure_.empty())failure_=std::string(name)+" failed "+hex32(hr);};
        for(auto pair:{std::make_pair(&capture_,"capture"),std::make_pair(&render_,"render")}){auto& e=*pair.first;if(e.started){quiet("STOP_RESULT",e.client->Stop(),pair.second);e.started=false;}if(e.registered){quiet("UNREGISTER_SESSION",e.control->UnregisterAudioSessionNotification(notices_),pair.second);e.registered=false;}}
        if(registered_&&enumerator_.p){quiet("UNREGISTER_ENDPOINT",enumerator_->UnregisterEndpointNotificationCallback(notices_),"both");registered_=false;}
        if(notices_){try{drainNotices(false);}catch(...){}notices_->Release();notices_=nullptr;}
        if(renderer_.p){renderer_.p->Release();renderer_.p=nullptr;}if(capturer_.p){capturer_.p->Release();capturer_.p=nullptr;}
        for(auto* e:{&capture_,&render_}){if(e->control.p){e->control.p->Release();e->control.p=nullptr;}if(e->clock.p){e->clock.p->Release();e->clock.p=nullptr;}if(e->client.p){e->client.p->Release();e->client.p=nullptr;}if(e->device.p){e->device.p->Release();e->device.p=nullptr;}}
        if(enumerator_.p){enumerator_.p->Release();enumerator_.p=nullptr;}if(mmcss_){AvRevertMmThreadCharacteristics(mmcss_);mmcss_=nullptr;}if(co_){CoUninitialize();co_=false;}released_=true;
    }
    void pollCommands(){Command c;while(commands_.next(c)){
        if(c.name=="STOP"||c.name=="END"){stop_=true;end_=c.name=="END";stopCommandId_=c.id;return;}
        emit({{"event","ERROR"},{"message","action busy"},{"reason","action busy"},{"commandId",c.id},{"takeId",takeId_},{"operation",operation_},{"recoverable",true},{"deviceReleased",false}});
    }}
    void readClock(){
        UINT64 position=0,qpc=0;const auto hr=render_.clock->GetPosition(&position,&qpc);const auto id="r"+s(sequence_+1);
        log("clock",{{"id",id},{"endpoint","render"},{"sourceApi","IAudioClock::GetPosition"},{"position",s(position)},{"frequency",s(render_.frequency)},{"qpc100ns",s(qpc)},{"hresult",hex32(hr)}});
        if(hr==S_FALSE)return;require(hr==S_OK,"render timestamp HRESULT error");
        require(compare(times(position,Fs),times(submittedFrames_,render_.frequency))<=0,"render underrun: clock passed submissions");
        renderHistory_.accept({id,position,render_.frequency,qpc});
        if(position>lastClockPosition_){lastClockPosition_=position;lastClockAdvance_=ticks();}
        require(ticks()-lastClockAdvance_<qpf_*2,"render clock stalled");
        if(!record_){playConsumed_=(std::min)(playEnd_-playFirst_,static_cast<std::uint64_t>((static_cast<long double>(position)*Fs)/render_.frequency));if(playConsumed_>=playEnd_-playFirst_)normalComplete_=true;}
    }
    void capturePackets(){for(;;){
        UINT32 available=0;require(capturer_->GetNextPacketSize(&available)==S_OK,"capture GetNextPacketSize failed");if(!available)return;
        BYTE* bytes=nullptr;UINT32 n=0;DWORD flags=0;UINT64 first=0,qpc=0;const auto hr=capturer_->GetBuffer(&bytes,&n,&flags,&first,&qpc);
        if(hr==AUDCLNT_S_BUFFER_EMPTY){require(n==0,"empty packet count");return;}require(hr==S_OK,"capture GetBuffer failed");bool owned=true;
        try{
            require(n>0,"empty S_OK packet");const auto id="c"+s(sequence_+1);log("clock",{{"id",id},{"endpoint","capture"},{"sourceApi","IAudioCaptureClient::GetBuffer"},{"position",s(first)},{"frequency","44100"},{"qpc100ns",s(qpc)},{"flags",flags}});
            continuity_.accept(first,n,flags);captureHistory_.accept({id,first,Fs,qpc});captureNow_=add(first,n);
            if(!sourceBegun_){sourceBegun_=true;first_=first;firstClick_=add(first,practice::PreRoll);captureEnd_=add(firstClick_,schedule_.captureEnd);}
            latestCaptureLocalFirst_=first-first_;latestCaptureQpc100ns_=qpc;
            const auto part=slice(first,n,first_,captureEnd_);json packet={{"firstFrame",first},{"frameCount",n},{"flags",flags},{"storedFirstFrame",part.count?json(part.first):json(nullptr)},{"storedFrameCount",part.count},{"storedByteLength",part.count*4}};
            if(part.count){require(part.first==first_+stored_,"stored PCM gap");std::vector<float> pcm;pcm.reserve(part.count);
                for(UINT32 k=0;k<part.count;++k){float sample=0;if(!(flags&AUDCLNT_BUFFERFLAGS_SILENT)){require(bytes!=nullptr,"non-silent packet is null");sample=decodeFloat24(bytes+(part.offset+k)*6+practice::inputByteOffset(inputChannel_));}pcm.push_back(sample);peak_=(std::max)(peak_,std::abs(static_cast<double>(sample)));squares_+=static_cast<double>(sample)*sample;if(sample<=-1||sample>=8388607.0f/8388608.0f)++clipped_;}
                if(preview_){for(float sample:pcm)firstNoteTracker_.push(sample);}else writer_->push({"pcm",{},std::move(pcm)});stored_+=part.count;
            }
            if(preview_){packet["memoryOnly"]=true;packet["savedPcm"]=false;packet["memoryFrameCount"]=part.count;packet["storedFrameCount"]=0;packet["storedByteLength"]=0;}log("packets",std::move(packet));const auto release=capturer_->ReleaseBuffer(n);owned=false;require(release==S_OK,"capture ReleaseBuffer failed");if(captureNow_>=captureEnd_){normalComplete_=true;return;}
        }catch(...){if(owned)capturer_->ReleaseBuffer(n);throw;}
    }}
    void renderBuffer(bool initial=false){
        BYTE* output=nullptr;require(renderer_->GetBuffer(render_.frames,&output)==S_OK,"render GetBuffer failed");require(output!=nullptr,"render buffer is null");std::memset(output,0,static_cast<std::size_t>(render_.frames)*6);
        const auto first=submittedFrames_,end=add(first,render_.frames);std::vector<std::size_t> starts;
        try{
            if(record_&&sourceBegun_&&!initial){
                for(std::size_t i=0;i<schedule_.clicks.size();++i){
                    if(!clickFrames_[i]){const auto target=add(firstClick_,schedule_.clicks[i].offset);const auto locked=reserveDue(target,first,renderHistory_,captureHistory_);if(locked){clickFrames_[i]=locked->prediction.renderFrame;reservations_[i]=reservationRecord(*locked,takeId_,takeId_,i,target,"planning-"+s(sequence_+1),render_.frames);reservations_[i]["variant"]=schedule_.clicks[i].variant;reservations_[i]["kind"]=schedule_.clicks[i].kind;log("reservations",reservations_[i]);}}
                    if(clickFrames_[i]&&startsInBuffer(*clickFrames_[i],first,render_.frames,clickSubmitted_[i]))starts.push_back(i);
                    if(clickFrames_[i]){const auto click=*clickFrames_[i],lo=(std::max)(click,first),hi=(std::min)(add(click,2205),end);if(lo<hi){const auto& source=resources_.at(schedule_.clicks[i].variant);const auto count=static_cast<std::size_t>(hi-lo)*6;std::memcpy(output+static_cast<std::size_t>(lo-first)*6,source.data()+static_cast<std::size_t>(lo-click)*6,count);clickBytes_[i]+=count;}}
                }
            }else if(!record_){
                const auto count=(std::min)(static_cast<std::uint64_t>(render_.frames),playEnd_-playFirst_-playSubmitted_);
                for(std::uint64_t i=0;i<count;++i)practice::encodeOutput0(output+static_cast<std::size_t>(i)*6,playback_[static_cast<std::size_t>(playFirst_+playSubmitted_+i)]);
                playSubmitted_+=count;
            }
            renderHasher_.update(output,static_cast<std::size_t>(render_.frames)*6);const auto hash=renderHasher_.finish();const auto hr=renderer_->ReleaseBuffer(render_.frames,0);output=nullptr;require(hr==S_OK,"render ReleaseBuffer failed");submittedFrames_=end;
            const auto releaseId="release-"+s(first);log("render-buffers",{{"id",releaseId},{"bufferFirstFrame",first},{"bufferFrameCount",render_.frames},{"sha256",hash},{"releaseSucceeded",true}});
            for(auto i:starts){auto row=commitSubmission(reservations_[i],first,render_.frames,releaseId,true);row["variant"]=schedule_.clicks[i].variant;row["countIn"]=schedule_.clicks[i].countIn;row["kind"]=schedule_.clicks[i].kind;row["noteNumber"]=schedule_.clicks[i].noteNumber?json(schedule_.clicks[i].noteNumber):json(nullptr);clickSubmitted_[i]=true;log("submissions",std::move(row));}
        }catch(...){if(output)renderer_->ReleaseBuffer(render_.frames,AUDCLNT_BUFFERFLAGS_SILENT);throw;}
    }
    std::size_t submittedClickCount()const{return static_cast<std::size_t>(std::count(clickSubmitted_.begin(),clickSubmitted_.end(),true));}
    void status(){
        if(preview_){const auto now=ticks();if(now-lastFirstNote_>=qpf_/5){lastFirstNote_=now;if(firstNotePending_.valid()&&firstNotePending_.wait_for(std::chrono::seconds(0))==std::future_status::ready){const auto reading=firstNotePending_.get();emit({{"event","FIRST_NOTE"},{"operation","first-note"},{"takeId",takeId_},{"taskId",taskId_},{"midi",reading.available?json(reading.midi):json(nullptr)},{"noteName",reading.available?json(reading.name):json(nullptr)},{"levelDbfs",reading.levelDbfs},{"clarity",reading.clarity},{"deviceReleased",false},{"purpose","input-display-only-not-frozen-analysis"},{"savedPcm",false},{"memoryFrameLimit",firstnote::Frames}});}if(!firstNotePending_.valid()){const auto snapshot=firstNoteTracker_;firstNotePending_=std::async(std::launch::async,[snapshot]{return snapshot.estimate();});}}return;}
        const auto elapsed=record_?(sourceBegun_?static_cast<double>(stored_)/Fs:0):static_cast<double>(playConsumed_)/Fs;
        const auto total=record_?static_cast<double>(practice::PreRoll+schedule_.captureEnd)/Fs:static_cast<double>(playEnd_-playFirst_)/Fs;
        const auto snapshotQpc=ticks();
        const auto projection=practice::projectCaptureClock(latestCaptureLocalFirst_,latestCaptureQpc100ns_,snapshotQpc,qpf_,practice::PreRoll+schedule_.captureEnd);
        const bool uiValid=record_&&sourceBegun_&&projection.valid;
        if(uiValid)lastUiSeconds_=(std::max)(lastUiSeconds_,projection.seconds);
        emit({{"event","STATUS"},{"operation",operation_},{"takeId",takeId_},{"phase",record_?practice::recordPhase(stored_,schedule_):"playback"},{"elapsedSeconds",elapsed},{"totalSeconds",total},{"submittedClickCount",submittedClickCount()},{"plannedClickCount",schedule_.clicks.size()},{"peakAbs",peak_},{"rms",stored_?std::sqrt(squares_/static_cast<double>(stored_)):0},{"clippedSamples",clipped_},{"levelMeaning","cumulative saved PCM"},{"deviceReleased",false},{"uiClockValid",uiValid},{"uiElapsedSeconds",uiValid?json(lastUiSeconds_):json(nullptr)},{"uiClockPacketAgeMs",record_&&sourceBegun_?json(projection.ageMs):json(nullptr)},{"uiClockBasis","capture-packet-QPC-projection-for-guidance-only"},{"uiClockMeaning","scheduled capture coordinates; acoustic and display latency not established"},{"statusSequence",++statusSequence_},{"snapshotRawQpcTicks",s(snapshotQpc)},{"rawQpcFrequency",s(qpf_)},{"bpm",record_?json(schedule_.bpm):json(nullptr)},{"subdivision",record_?json(schedule_.subdivision):json(nullptr)},{"scheduleVersion",practice::scheduleVersion(schedule_)}});
    }
    void loop(){HANDLE waits[2]={render_.event,capture_.event};for(;;){
        pollCommands();if(stop_)return;drainNotices(true);if(writer_)require(!writer_->failed.load(std::memory_order_acquire),"writer failed");
        const auto result=WaitForMultipleObjects(record_?2:1,waits,FALSE,100);require(result!=WAIT_FAILED&&result!=WAIT_TIMEOUT,"audio event timeout/failure");
        readClock();if(record_)capturePackets();if(normalComplete_){status();return;}
        if(result==WAIT_OBJECT_0||WaitForSingleObject(render_.event,0)==WAIT_OBJECT_0)renderBuffer();
        const auto now=ticks();if(now-lastStatus_>=qpf_/20){lastStatus_=now;status();}
    }}
    void saveTake(){
        require(writer_!=nullptr,"capture writer missing");writer_->stop();if(writer_->failed.load(std::memory_order_acquire)){if(!failure_.empty())failure_+="; ";failure_+="capture writer failed: "+writer_->error;}
        const auto pcmPath=takePath_/L"pcm.f32le",runPath=takePath_/L"run.json";const auto data=read(pcmPath);require(data.size()%4==0,"serialized PCM alignment");
        if(data.size()/4!=stored_&&failure_.empty())failure_="serialized PCM length mismatch";const auto actualFrames=data.size()/4;
        peak_=0;squares_=0;clipped_=0;for(std::size_t offset=0;offset<data.size();offset+=4){float sample=0;std::memcpy(&sample,data.data()+offset,4);require(std::isfinite(sample),"serialized PCM sample invalid");peak_=(std::max)(peak_,std::abs(static_cast<double>(sample)));squares_+=static_cast<double>(sample)*sample;if(sample<=-1||sample>=8388607.0f/8388608.0f)++clipped_;}stored_=actualFrames;
        const bool submissionsComplete=submittedClickCount()==schedule_.clicks.size()&&std::all_of(clickBytes_.begin(),clickBytes_.end(),[](auto bytes){return bytes==13230;});
        if(normalComplete_&&!submissionsComplete&&failure_.empty())failure_="click submission incomplete";
        const bool complete=normalComplete_&&!stop_&&sourceBegun_&&actualFrames==captureEnd_-first_;
        const bool valid=complete&&failure_.empty()&&submissionsComplete;
        json reasons=json::array();if(!failure_.empty())reasons.push_back(failure_);if(stop_)reasons.push_back("user-stop");
        const auto localBoundaries=practiceLocalBoundaries(schedule_);
        json absoluteBoundaries=nullptr;if(sourceBegun_){absoluteBoundaries=json::object();for(auto it=localBoundaries.begin();it!=localBoundaries.end();++it)absoluteBoundaries[it.key()]=first_+it.value().get<std::uint64_t>();}
        json rows=json::array();for(std::size_t i=0;i<schedule_.clicks.size();++i)rows.push_back({{"index",i},{"countIn",schedule_.clicks[i].countIn},{"accent",schedule_.clicks[i].accent},{"variant",schedule_.clicks[i].variant},{"kind",schedule_.clicks[i].kind},{"noteNumber",schedule_.clicks[i].noteNumber?json(schedule_.clicks[i].noteNumber):json(nullptr)},{"pcmLocalFrame",practice::PreRoll+schedule_.clicks[i].offset},{"requestedCaptureFrame",sourceBegun_?json(firstClick_+schedule_.clicks[i].offset):json(nullptr)},{"actualRenderFrame",clickFrames_[i]?json(*clickFrames_[i]):json(nullptr)},{"submitted",clickSubmitted_[i]},{"submittedWaveformBytes",clickBytes_[i]}});
        json ledgers=json::object();for(const auto* name:{"events","clock","packets","reservations","submissions","render-buffers"})ledgers[name]=narrow((ledgerPath_/(std::string(name)+".jsonl")).wstring());
        json meta={{"schema",basslab::guided::RunSchema},{"takeId",takeId_},{"bpm",schedule_.bpm},{"subdivision",schedule_.subdivision},{"startedAt",startedAt_},{"finishedAt",finishedAt_},{"complete",complete},{"valid",valid},{"interrupted",stop_},{"invalidReasons",reasons},{"calibrationStatus",clickCalibration_.is_object()&&clickCalibration_.value("validatedForThisEngine",false)?"snapshot-applied":"default-provisional"},{"engineVersion",Program},{"scheduleVersion",practice::scheduleVersion(schedule_)},{"sourceAndBuildIdentities",identities_},{"playbackPath","release-and-reopen-same-output"},{"plannedClickCount",schedule_.clicks.size()},{"actualSubmittedClickCount",submittedClickCount()},{"countInClickCount",practice::CountInClicks},{"practiceClickCount",schedule_.clicks.size()-practice::CountInClicks-1},{"finishClickCount",1},{"plannedNoteCount",schedule_.plannedNoteCount},{"participant",participant_},{"taskId",taskId_},{"monitorRoute",monitorRoute_},{"clickMode",clickMode_},{"captureLengthSeconds",static_cast<double>(actualFrames)/Fs},{"captureQuality",{{"peakAbs",peak_},{"rms",stored_?std::sqrt(squares_/static_cast<double>(stored_)):0},{"clippedSamples",clipped_},{"clipping",clipped_>0}}},{"format",{{"sampleRate",44100},{"channels",2},{"containerBits",24},{"validBits",24},{"inputIndex",inputChannel_-1},{"outputIndex",0},{"shareMode","exclusive"},{"bufferFrames",441}}},{"pcm",{{"path",narrow(pcmPath.wstring())},{"sampleRate",44100},{"channels",1},{"encoding","f32le"},{"firstFrame",sourceBegun_?json(first_):json(nullptr)},{"lastFrameExclusive",sourceBegun_?json(first_+actualFrames):json(nullptr)},{"frameCount",actualFrames},{"byteLength",data.size()},{"sha256",digest(data.data(),data.size())}}},{"boundaries",{{"pcmLocalFrames",localBoundaries},{"captureStreamFrames",absoluteBoundaries},{"meaning","scheduled capture coordinates; actual acoustic arrival is not established"},{"tailSeconds",2}}},{"schedule",rows},{"operation",operation_},{"deviceSelection",deviceSelection_},{"clickCalibration",clickCalibration_},{"renderEndpointId",narrow(renderId_.c_str())},{"captureEndpointId",narrow(captureId_.c_str())},{"outputChannelNote","output index 0 only; index 1 silent"},{"ledgerPaths",ledgers},{"deviceReleased",released_},{"initializeCalls",initializeCalls_},{"startApiEntries",startCalls_},{"detectorCalls",0},{"analysisCalls",0},{"physicalTimestampAccuracy","unknown"}};
        if(calibration_){meta["kind"]="C";meta["operation"]="calibration";meta["bpm"]=nullptr;meta["subdivision"]=nullptr;meta["calibrationStatus"]=valid?"calculation-incomplete":"invalidated";meta["scheduleVersion"]=practice::CalibrationScheduleVersion;meta["countInClickCount"]=0;meta["practiceClickCount"]=0;meta["finishClickCount"]=0;meta["plannedNoteCount"]=0;meta["calibrationClickCount"]=16;meta["boundaries"]["pcmLocalFrames"]={{"preparingStart",0},{"calibrationStart",practice::PreRoll},{"lastClick",practice::PreRoll+schedule_.practiceEnd},{"captureEnd",practice::PreRoll+schedule_.captureEnd}};meta["boundaries"]["captureStreamFrames"]=nullptr;if(sourceBegun_){meta["boundaries"]["captureStreamFrames"]=json::object();for(auto it=meta["boundaries"]["pcmLocalFrames"].begin();it!=meta["boundaries"]["pcmLocalFrames"].end();++it)meta["boundaries"]["captureStreamFrames"][it.key()]=first_+it.value().get<std::uint64_t>();}meta["boundaries"]["tailSeconds"]=static_cast<double>(practice::CalibrationStopOffset-practice::CalibrationOffsets.back())/Fs;meta["calibrationScheduleIdentity"]={{"seed",250725},{"baseIntervalMs",800},{"jitterPct",7},{"frozenOffsetsFrames",practice::CalibrationOffsets},{"stopOffsetFrames",practice::CalibrationStopOffset},{"source","Stage2RR engine-config.json C and schedule.cjs calibrationPlan"}};}
        File file;file.open(runPath);file.line(meta);file.close();
        emit({{"event",calibration_?"CALIBRATION_SAVED":"TAKE_SAVED"},{"operation",operation_},{"takeId",takeId_},{"runPath",narrow(runPath.wstring())},{"pcmPath",narrow(pcmPath.wstring())},{"complete",complete},{"valid",valid},{"interrupted",stop_},{"invalidReasons",reasons},{"frameCount",actualFrames},{"byteLength",data.size()},{"plannedClickCount",schedule_.clicks.size()},{"actualSubmittedClickCount",submittedClickCount()},{"deviceReleased",released_}});
    }
};
void ready(bool startup=false){json row={{"event","READY"},{"phase","idle"},{"deviceReleased",true},{"deviceCallsDuringReady",0},{"productionEnabled",false},{"program",Program}};if(startup)row["deviceCalls"]=0;emit(std::move(row));}
int serve(const fs::path& root,const fs::path& resourcesPath,const fs::path& runtime){
    require(root==PackageRoot/L"takes","practice take root mismatch");portablePath(root);plain(root,true);portablePath(runtime);plain(runtime,true);
    require(runtime.parent_path()==PackageRoot/L"runtime","runtime root mismatch");
    Resources resources(resourcesPath);const auto identities=engineIdentities();Commands commands;unsigned ordinal=0;ready(true);
    for(;;){Command c;try{if(!commands.next(c)){Sleep(20);continue;}
        if(c.name=="END"){emit({{"event","SESSION_ENDED"},{"deviceReleased",true},{"commandId",c.id}});return 0;}
        if(c.name=="STOP"){emit({{"event","STOPPED"},{"operation","none"},{"deviceReleased",true},{"commandId",c.id}});ready();continue;}
        require(c.name=="RECORD"||c.name=="PLAY"||c.name=="FIRST_NOTE"||c.name=="CALIBRATE","unknown command");
        Action action(c,root,runtime,resources,identities,commands,++ordinal);action.execute();
        require(action.deviceReleased(),"device release incomplete");if(action.endRequested()){emit({{"event","SESSION_ENDED"},{"deviceReleased",true}});return 0;}if(commands.failed()){emit({{"event","SESSION_ENDED"},{"deviceReleased",true},{"reason","input reader failed"}});return 1;}ready();
    }catch(const std::exception& ex){
        const std::string reason=ex.what();emit({{"event","ERROR"},{"message",reason},{"reason",reason},{"commandId",c.id},{"deviceReleased",true},{"recoverable",!commands.failed()}});
        if(commands.failed()){emit({{"event","SESSION_ENDED"},{"deviceReleased",true},{"reason",reason}});return 1;}ready();
    }}
}
} // namespace
#ifndef BASSLAB_PRACTICE_TESTING
int wmain(int argc,wchar_t** argv){try{
    initializePackageRoot();
    if(argc==2&&std::wstring(argv[1])==L"--enumerate-devices"){enumerateDevices();return 0;}
    if(argc==2&&std::wstring(argv[1])==L"--help"){emit({{"program",Program},{"usage","--serve --root PACKAGE/takes --resources PACKAGE/resources --runtime PACKAGE/runtime/SESSION"},{"packageRoot",narrow(PackageRoot.wstring())},{"deviceCalls",0}});return 0;}
    require(argc==8&&std::wstring(argv[1])==L"--serve","invalid arguments");std::map<std::wstring,fs::path> args;
    for(int i=2;i<argc;i+=2){const auto key=std::wstring(argv[i]);require(key==L"--root"||key==L"--resources"||key==L"--runtime","unknown argument");require(args.emplace(key,argv[i+1]).second,"duplicate argument");}
    require(args.size()==3,"missing arguments");return serve(args.at(L"--root"),args.at(L"--resources"),args.at(L"--runtime"));
}catch(const std::exception& ex){emit({{"event","ERROR"},{"message",ex.what()},{"reason",ex.what()},{"deviceReleased",true},{"recoverable",false}});return 1;}}
#endif
